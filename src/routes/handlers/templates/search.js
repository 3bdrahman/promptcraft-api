/**
 * Template Semantic Search API
 * AI-powered template discovery and recommendations
 */

import { db } from '../../../utils/database.js';
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

    const {
      query_text,
      query_embedding = null,
      limit = 10,
      min_similarity = 0.7,
      exclude_ids = []
    } = req.body;

    if (!query_text && !query_embedding) {
      return res.status(400).json(error('query_text or query_embedding is required'));
    }

    // Generate embedding from query_text if not provided
    let embedding = query_embedding;
    if (!embedding && query_text) {
      console.log(`🔍 [Template Search] Generating embedding for query: "${query_text.substring(0, 50)}..."`);
      embedding = await generateEmbedding(query_text);
    }

    if (!embedding) {
      return res.status(500).json(error('Failed to generate embedding'));
    }

    // Use the find_similar_templates function from migration
    const result = await db.query(
      `SELECT * FROM find_similar_templates(
        $1::vector(384),
        $2::UUID,
        $3::INT,
        $4::DECIMAL,
        $5::UUID[]
      )`,
      [`[${embedding.join(',')}]`, userId, limit, min_similarity, exclude_ids]
    );

    return res.json(success({ templates: result.rows }));
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

    const {
      limit = 10,
      min_similarity = 0.7
    } = req.query;

    // Verify template exists
    const templateCheck = await db.query(
      `SELECT id, name FROM templates WHERE id = $1 AND deleted_at IS NULL`,
      [templateId]
    );

    if (templateCheck.rows.length === 0) {
      return res.status(404).json(error('Template not found', 404));
    }

    // Get embedding from template_embeddings table
    const embeddingResult = await db.query(
      `SELECT embedding FROM template_embeddings WHERE template_id = $1`,
      [templateId]
    );

    if (embeddingResult.rows.length === 0 || !embeddingResult.rows[0].embedding) {
      return res.json(success({
        similar: [],
        message: 'This template does not have an embedding yet. Please trigger embedding generation.'
      }));
    }

    const embedding = embeddingResult.rows[0].embedding;

    // Find similar templates using the migration function
    const result = await db.query(
      `SELECT * FROM find_similar_templates(
        $1::vector(384),
        $2::UUID,
        $3::INT,
        $4::DECIMAL,
        ARRAY[$5]::UUID[]
      )`,
      [embedding, userId, parseInt(limit), parseFloat(min_similarity), templateId]
    );

    return res.json(success({ similar: result.rows }));
  } catch (err) {
    console.error('Find similar templates error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/templates/:id/generate-embedding
 * Queue template for embedding generation
 */
export async function queueTemplateEmbeddingGeneration(req, res, templateId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { priority = 5 } = req.body;

    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM templates WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [templateId, userId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Template not found', 404));
    }

    // Add to queue using the migration table name
    const result = await db.query(
      `INSERT INTO embedding_queue (resource_type, resource_id, priority, status)
       VALUES ('template', $1, $2, 'pending')
       ON CONFLICT (resource_type, resource_id, status)
       DO UPDATE SET priority = $2, retry_count = 0
       RETURNING *`,
      [templateId, priority]
    );

    return res.status(201).json(success({
      queued: true,
      queue_item: result.rows[0]
    }));
  } catch (err) {
    console.error('Queue template embedding generation error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
