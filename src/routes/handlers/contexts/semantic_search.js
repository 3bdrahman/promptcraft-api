/**
 * Semantic Search Handler for Contexts - Updated for Enterprise Schema
 * Uses unified embedding table with pgvector
 *
 * @module handlers/contexts/semantic_search
 */

import { db, ensureTenant } from '../../../utils/database.js';
import { getUserId } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';
import { generateEmbedding } from '../../../services/localEmbeddingService.js';

/**
 * POST /api/contexts/search
 * Semantic search for contexts using vector similarity
 */
export async function semanticSearchContexts(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const tenantId = await ensureTenant(userId);

    const {
      query_text,
      limit = 10,
      min_similarity = 0.7,
      exclude_ids = []
    } = req.body;

    if (!query_text || query_text.trim().length === 0) {
      return res.status(400).json(error('query_text is required'));
    }

    // Generate embedding for the query
    const startTime = Date.now();
    const { embedding } = await generateEmbedding(query_text);
    const embeddingTime = Date.now() - startTime;

    // Convert embedding to pgvector format
    const vectorString = `[${embedding.join(',')}]`;

    // Search contexts using the enterprise schema search function
    const searchResults = await db.query(
      `SELECT * FROM search_similar_entities(
        $1::UUID,
        $2::vector(1536),
        'context',
        $3::INTEGER
      ) WHERE similarity >= $4
        AND entity_id != ALL($5::UUID[])`,
      [
        tenantId,
        vectorString,
        limit * 2, // Get more results to filter
        min_similarity,
        exclude_ids.length > 0 ? exclude_ids : ['00000000-0000-0000-0000-000000000000']
      ]
    );

    // Get full entity details for results
    const entityIds = searchResults.rows.map(r => r.entity_id);
    if (entityIds.length === 0) {
      return res.json(success({
        query: query_text,
        contexts: [],
        count: 0,
        timing: { embedding_ms: embeddingTime }
      }));
    }

    const entities = await db.query(
      `SELECT e.id, e.title as name, e.description,
              e.metadata->>'layer_type' as layer_type,
              e.content, e.tags, e.created_at, e.updated_at
       FROM entity e
       WHERE e.id = ANY($1::UUID[])
         AND e.entity_type = 'context'
         AND e.valid_to IS NULL
         AND e.deleted_at IS NULL
       LIMIT $2`,
      [entityIds, limit]
    );

    // Merge similarity scores with entity data
    const resultsMap = new Map(searchResults.rows.map(r => [r.entity_id, r.similarity]));
    const contexts = entities.rows.map(row => ({
      context_id: row.id,
      context_name: row.name,
      layer_type: row.layer_type || 'adhoc',
      description: row.description,
      content_preview: typeof row.content === 'string'
        ? row.content.substring(0, 200)
        : JSON.stringify(row.content).substring(0, 200),
      tags: row.tags,
      similarity: resultsMap.get(row.id) || 0,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    // Sort by similarity
    contexts.sort((a, b) => b.similarity - a.similarity);

    return res.json(success({
      query: query_text,
      contexts,
      count: contexts.length,
      timing: {
        embedding_ms: embeddingTime,
        total_ms: Date.now() - startTime
      }
    }));

  } catch (err) {
    console.error('Context semantic search error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/layers/:id/similar
 * Find contexts similar to a specific context
 */
export async function findSimilarContexts(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const tenantId = await ensureTenant(userId);

    const {
      limit = 10,
      min_similarity = 0.7
    } = req.query;

    // Verify context exists and get its embedding
    const embeddingResult = await db.query(
      `SELECT emb.vector, e.title
       FROM embedding emb
       JOIN entity e ON emb.entity_id = e.id
       WHERE emb.entity_id = $1
         AND e.owner_id = $2
         AND e.entity_type = 'context'
         AND e.valid_to IS NULL
         AND e.deleted_at IS NULL
         AND emb.status = 'completed'
       LIMIT 1`,
      [contextId, userId]
    );

    if (embeddingResult.rows.length === 0) {
      return res.status(404).json(error('Context not found or embedding not generated', 404));
    }

    const queryVector = embeddingResult.rows[0].vector;
    const contextName = embeddingResult.rows[0].title;

    // Find similar contexts
    const similarResults = await db.query(
      `SELECT * FROM search_similar_entities(
        $1::UUID,
        $2::vector(1536),
        'context',
        $3::INTEGER
      ) WHERE similarity >= $4
        AND entity_id != $5`,
      [tenantId, queryVector, limit + 1, min_similarity, contextId]
    );

    // Get full entity details
    const entityIds = similarResults.rows
      .filter(r => r.entity_id !== contextId)
      .map(r => r.entity_id)
      .slice(0, limit);

    if (entityIds.length === 0) {
      return res.json(success({
        context_id: contextId,
        context_name: contextName,
        similar_contexts: []
      }));
    }

    const entities = await db.query(
      `SELECT e.id, e.title as name, e.description,
              e.metadata->>'layer_type' as layer_type,
              e.tags, e.created_at
       FROM entity e
       WHERE e.id = ANY($1::UUID[])
         AND e.entity_type = 'context'
         AND e.valid_to IS NULL
         AND e.deleted_at IS NULL`,
      [entityIds]
    );

    // Merge with similarity scores
    const resultsMap = new Map(similarResults.rows.map(r => [r.entity_id, r.similarity]));
    const similarContexts = entities.rows.map(row => ({
      context_id: row.id,
      context_name: row.name,
      layer_type: row.layer_type || 'adhoc',
      description: row.description,
      tags: row.tags,
      similarity: resultsMap.get(row.id) || 0,
      created_at: row.created_at
    }));

    similarContexts.sort((a, b) => b.similarity - a.similarity);

    return res.json(success({
      context_id: contextId,
      context_name: contextName,
      similar_contexts: similarContexts
    }));

  } catch (err) {
    console.error('Find similar contexts error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

export default {
  semanticSearchContexts,
  findSimilarContexts
};
