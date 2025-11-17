/**
 * Semantic Search Handler for Contexts
 *
 * Provides semantic similarity search across user's context layers
 *
 * @module handlers/contexts/semantic_search
 */

import { db } from '../../utils/database.js';
import { getUserId } from '../../utils/auth.js';
import { success, error } from '../../utils/responses.js';
import { generateEmbedding } from '../../services/localEmbeddingService.js';

/**
 * POST /api/contexts/search
 * Semantic search for contexts
 *
 * Body:
 * - query_text: Search query
 * - limit: Maximum results (default 10)
 * - min_similarity: Minimum similarity threshold (default 0.7)
 * - exclude_ids: Array of context IDs to exclude
 */
export async function semanticSearchContexts(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

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

    // Search contexts using vector similarity
    const searchResults = await db.query(
      `SELECT
         cl.context_id,
         cl.name as context_name,
         cl.layer_type,
         cl.description,
         cl.priority,
         cl.token_count,
         SUBSTRING(cl.content, 1, 200) as content_preview,
         1 - (ce.embedding <=> $1::vector(384)) as similarity
       FROM context_layers cl
       INNER JOIN context_embeddings ce ON ce.context_id = cl.context_id
       WHERE cl.user_id = $2
         AND cl.is_active = true
         AND (1 - (ce.embedding <=> $1::vector(384))) >= $3
         AND cl.context_id != ALL($4::UUID[])
       ORDER BY similarity DESC
       LIMIT $5`,
      [
        `[${embedding.join(',')}]`,
        userId,
        min_similarity,
        exclude_ids.length > 0 ? exclude_ids : ['00000000-0000-0000-0000-000000000000'],
        limit
      ]
    );

    const results = {
      query: query_text,
      contexts: searchResults.rows.map(row => ({
        context_id: row.context_id,
        context_name: row.context_name,
        layer_type: row.layer_type,
        description: row.description,
        priority: row.priority,
        token_count: row.token_count,
        content_preview: row.content_preview,
        similarity: parseFloat(row.similarity)
      })),
      total_results: searchResults.rows.length,
      embedding_time_ms: embeddingTime,
      total_time_ms: Date.now() - startTime
    };

    return res.json(success(results));
  } catch (err) {
    console.error('Semantic search error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/layers/:id/similar
 * Find contexts similar to a specific context
 *
 * Query params:
 * - limit: Maximum results (default 10)
 * - min_similarity: Minimum similarity threshold (default 0.7)
 */
export async function findSimilarContexts(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { id } = req.params;
    const { limit = 10, min_similarity = 0.7 } = req.query;

    // Get the source context's embedding
    const sourceContext = await db.query(
      `SELECT ce.embedding, cl.name
       FROM context_embeddings ce
       INNER JOIN context_layers cl ON cl.context_id = ce.context_id
       WHERE ce.context_id = $1 AND cl.user_id = $2`,
      [id, userId]
    );

    if (sourceContext.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    const sourceEmbedding = sourceContext.rows[0].embedding;
    const sourceName = sourceContext.rows[0].name;

    // Find similar contexts
    const similarResults = await db.query(
      `SELECT
         cl.context_id,
         cl.name as context_name,
         cl.layer_type,
         cl.description,
         cl.priority,
         cl.token_count,
         SUBSTRING(cl.content, 1, 200) as content_preview,
         1 - (ce.embedding <=> $1) as similarity
       FROM context_layers cl
       INNER JOIN context_embeddings ce ON ce.context_id = cl.context_id
       WHERE cl.user_id = $2
         AND cl.is_active = true
         AND cl.context_id != $3
         AND (1 - (ce.embedding <=> $1)) >= $4
       ORDER BY similarity DESC
       LIMIT $5`,
      [sourceEmbedding, userId, id, parseFloat(min_similarity), parseInt(limit)]
    );

    const results = {
      source_context_id: id,
      source_context_name: sourceName,
      similar_contexts: similarResults.rows.map(row => ({
        context_id: row.context_id,
        context_name: row.context_name,
        layer_type: row.layer_type,
        description: row.description,
        priority: row.priority,
        token_count: row.token_count,
        content_preview: row.content_preview,
        similarity: parseFloat(row.similarity)
      })),
      total_results: similarResults.rows.length
    };

    return res.json(success(results));
  } catch (err) {
    console.error('Find similar contexts error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

export default {
  semanticSearchContexts,
  findSimilarContexts
};
