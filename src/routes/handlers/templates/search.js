/**
 * Template Semantic Search API - Updated for Enterprise Schema
 * Uses unified embedding table with pgvector
 */

import { db, ensureTenant } from '../../../utils/database.js';
import { getUserId } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';
import { generateEmbedding } from '../../../services/embeddingService.js';

/**
 * POST /api/templates/search
 * Semantic search for templates using vector similarity
 */
export async function semanticTemplateSearch(req, res) {
  try {
    const userId = await getUserId(req);
    const tenantId = userId ? await ensureTenant(userId) : null;

    const {
      query_text,
      query_embedding = null,
      limit = 10,
      min_similarity = 0.7,
      exclude_ids = [],
      include_public = true
    } = req.body;

    if (!query_text && !query_embedding) {
      return res.status(400).json(error('query_text or query_embedding is required'));
    }

    // Generate embedding from query_text if not provided
    let embedding = query_embedding;
    if (!embedding && query_text) {
      console.log(`🔍 [Template Search] Generating embedding for query: "${query_text.substring(0, 50)}..."`);
      const result = await generateEmbedding(query_text);
      embedding = result.embedding || result;
    }

    if (!embedding || !Array.isArray(embedding)) {
      return res.status(500).json(error('Failed to generate embedding'));
    }

    const vectorString = `[${embedding.join(',')}]`;

    // Build query for templates (can be user's own or public)
    let searchQuery;
    let params;

    if (userId && tenantId) {
      // Authenticated: search user's templates and public ones
      searchQuery = `
        SELECT e.id as entity_id, e.title,
               1 - (emb.vector <=> $1::vector(1536)) as similarity
        FROM embedding emb
        JOIN entity e ON emb.entity_id = e.id
        WHERE e.entity_type = 'template'
          AND e.valid_to IS NULL
          AND e.deleted_at IS NULL
          AND emb.status = 'completed'
          AND (e.owner_id = $2 OR (e.visibility = 'public' AND $3::boolean))
          AND (1 - (emb.vector <=> $1::vector(1536))) >= $4
          AND e.id != ALL($5::UUID[])
        ORDER BY similarity DESC
        LIMIT $6
      `;
      params = [
        vectorString,
        userId,
        include_public,
        min_similarity,
        exclude_ids.length > 0 ? exclude_ids : ['00000000-0000-0000-0000-000000000000'],
        limit
      ];
    } else {
      // Unauthenticated: only public templates
      searchQuery = `
        SELECT e.id as entity_id, e.title,
               1 - (emb.vector <=> $1::vector(1536)) as similarity
        FROM embedding emb
        JOIN entity e ON emb.entity_id = e.id
        WHERE e.entity_type = 'template'
          AND e.valid_to IS NULL
          AND e.deleted_at IS NULL
          AND e.visibility = 'public'
          AND emb.status = 'completed'
          AND (1 - (emb.vector <=> $1::vector(1536))) >= $2
          AND e.id != ALL($3::UUID[])
        ORDER BY similarity DESC
        LIMIT $4
      `;
      params = [
        vectorString,
        min_similarity,
        exclude_ids.length > 0 ? exclude_ids : ['00000000-0000-0000-0000-000000000000'],
        limit
      ];
    }

    const searchResults = await db.query(searchQuery, params);

    // Get full template details
    if (searchResults.rows.length === 0) {
      return res.json(success({ templates: [] }));
    }

    const entityIds = searchResults.rows.map(r => r.entity_id);
    const templates = await db.query(
      `SELECT e.id, e.title as name, e.description, e.content,
              e.metadata->>'category' as category,
              e.metadata->>'variables' as variables,
              e.visibility, e.owner_id as user_id,
              e.created_at, e.updated_at,
              COALESCE((SELECT COUNT(*) FROM favorite f WHERE f.entity_id = e.id), 0) as favorite_count
       FROM entity e
       WHERE e.id = ANY($1::UUID[])
         AND e.entity_type = 'template'
         AND e.valid_to IS NULL
         AND e.deleted_at IS NULL`,
      [entityIds]
    );

    // Merge with similarity scores
    const resultsMap = new Map(searchResults.rows.map(r => [r.entity_id, r.similarity]));
    const templatesWithScores = templates.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      content: typeof row.content === 'string' ? row.content : row.content?.text || JSON.stringify(row.content),
      category: row.category,
      variables: row.variables,
      visibility: row.visibility,
      user_id: row.user_id,
      favorite_count: parseInt(row.favorite_count) || 0,
      similarity: resultsMap.get(row.id) || 0,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    // Sort by similarity
    templatesWithScores.sort((a, b) => b.similarity - a.similarity);

    return res.json(success({ templates: templatesWithScores }));

  } catch (err) {
    console.error('Template semantic search error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/templates/:id/similar
 * Find templates similar to a specific template
 */
export async function findSimilarTemplates(req, res, templateId) {
  try {
    const userId = await getUserId(req);
    const tenantId = userId ? await ensureTenant(userId) : null;

    const {
      limit = 10,
      min_similarity = 0.7
    } = req.query;

    // Get template embedding
    const embeddingResult = await db.query(
      `SELECT emb.vector, e.title as name, e.visibility, e.owner_id
       FROM embedding emb
       JOIN entity e ON emb.entity_id = e.id
       WHERE emb.entity_id = $1
         AND e.entity_type = 'template'
         AND e.valid_to IS NULL
         AND e.deleted_at IS NULL
         AND emb.status = 'completed'
       LIMIT 1`,
      [templateId]
    );

    if (embeddingResult.rows.length === 0) {
      return res.status(404).json(error('Template not found or embedding not available', 404));
    }

    const { vector: queryVector, name: templateName, visibility, owner_id } = embeddingResult.rows[0];

    // Check permissions
    if (visibility === 'private' && (!userId || userId !== owner_id)) {
      return res.status(403).json(error('Access denied', 403));
    }

    // Find similar templates
    let similarQuery;
    let params;

    if (userId && tenantId) {
      similarQuery = `
        SELECT e.id, e.title as name, e.description,
               e.metadata->>'category' as category,
               e.visibility,
               1 - (emb.vector <=> $1::vector(1536)) as similarity,
               COALESCE((SELECT COUNT(*) FROM favorite f WHERE f.entity_id = e.id), 0) as favorite_count
        FROM embedding emb
        JOIN entity e ON emb.entity_id = e.id
        WHERE e.entity_type = 'template'
          AND e.valid_to IS NULL
          AND e.deleted_at IS NULL
          AND e.id != $2
          AND emb.status = 'completed'
          AND (e.owner_id = $3 OR e.visibility = 'public')
          AND (1 - (emb.vector <=> $1::vector(1536))) >= $4
        ORDER BY similarity DESC
        LIMIT $5
      `;
      params = [queryVector, templateId, userId, min_similarity, limit];
    } else {
      similarQuery = `
        SELECT e.id, e.title as name, e.description,
               e.metadata->>'category' as category,
               e.visibility,
               1 - (emb.vector <=> $1::vector(1536)) as similarity,
               COALESCE((SELECT COUNT(*) FROM favorite f WHERE f.entity_id = e.id), 0) as favorite_count
        FROM embedding emb
        JOIN entity e ON emb.entity_id = e.id
        WHERE e.entity_type = 'template'
          AND e.valid_to IS NULL
          AND e.deleted_at IS NULL
          AND e.id != $2
          AND e.visibility = 'public'
          AND emb.status = 'completed'
          AND (1 - (emb.vector <=> $1::vector(1536))) >= $3
        ORDER BY similarity DESC
        LIMIT $4
      `;
      params = [queryVector, templateId, min_similarity, limit];
    }

    const results = await db.query(similarQuery, params);

    return res.json(success({
      template_id: templateId,
      template_name: templateName,
      similar_templates: results.rows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        category: row.category,
        visibility: row.visibility,
        similarity: parseFloat(row.similarity),
        favorite_count: parseInt(row.favorite_count) || 0
      }))
    }));

  } catch (err) {
    console.error('Find similar templates error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/templates/:id/generate-embedding
 * Queue or generate embedding for a template
 */
export async function queueTemplateEmbeddingGeneration(req, res, templateId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const tenantId = await ensureTenant(userId);

    // Verify template exists and user owns it
    const template = await db.query(
      `SELECT e.id, e.title, e.content, e.description
       FROM entity e
       WHERE e.id = $1
         AND e.owner_id = $2
         AND e.entity_type = 'template'
         AND e.valid_to IS NULL
         AND e.deleted_at IS NULL`,
      [templateId, userId]
    );

    if (template.rows.length === 0) {
      return res.status(404).json(error('Template not found', 404));
    }

    // Generate embedding immediately (or queue for async processing)
    const templateData = template.rows[0];
    const textToEmbed = `${templateData.title}\n${templateData.description || ''}\n${
      typeof templateData.content === 'string' ? templateData.content : templateData.content?.text || JSON.stringify(templateData.content)
    }`;

    const { embedding } = await generateEmbedding(textToEmbed);
    const contentHash = require('crypto').createHash('sha256').update(textToEmbed).digest('hex');

    // Store embedding
    await db.query(
      `INSERT INTO embedding (tenant_id, entity_id, model, content_hash, vector, status)
       VALUES ($1, $2, $3, $4, $5, 'completed')
       ON CONFLICT (entity_id, model)
       DO UPDATE SET vector = EXCLUDED.vector, content_hash = EXCLUDED.content_hash,
                     status = 'completed', updated_at = NOW()`,
      [tenantId, templateId, 'default', contentHash, `[${embedding.join(',')}]`]
    );

    return res.json(success({
      template_id: templateId,
      embedding_status: 'completed',
      message: 'Embedding generated successfully'
    }));

  } catch (err) {
    console.error('Generate template embedding error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

export default {
  semanticTemplateSearch,
  findSimilarTemplates,
  queueTemplateEmbeddingGeneration
};
