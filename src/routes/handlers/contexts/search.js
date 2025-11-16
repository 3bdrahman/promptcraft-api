/**
 * Context Semantic Search API
 * AI-powered context discovery and recommendations
 */

import { db } from '../../../utils/database.js';
import { getUserId } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';
import { generateEmbedding } from '../../../services/embeddingService.js';

/**
 * POST /api/contexts/search
 * Semantic search for contexts using vector similarity
 */
export async function semanticSearch(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

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
      console.log(`🔍 [Search] Generating embedding for query: "${query_text.substring(0, 50)}..."`);
      embedding = await generateEmbedding(query_text);
    }

    // Use the find_similar_contexts function from migration 013
    const result = await db.query(
      `SELECT * FROM find_similar_contexts(
        $1::vector(384),
        $2::UUID,
        $3::INT,
        $4::DECIMAL,
        $5::UUID[]
      )`,
      [`[${embedding.join(',')}]`, userId, limit, min_similarity, exclude_ids]
    );

    return res.json(success({ contexts: result.rows }));
  } catch (err) {
    console.error('Semantic search error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/recommend
 * Get AI-powered context recommendations
 */
export async function getRecommendations(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      prompt_text,
      prompt_embedding = null,
      limit = 10
    } = req.body;

    if (!prompt_text && !prompt_embedding) {
      return res.status(400).json(error('prompt_text or prompt_embedding is required'));
    }

    // Generate embedding from prompt_text if not provided
    let embedding = prompt_embedding;
    if (!embedding && prompt_text) {
      console.log(`🤖 [Recommendations] Generating embedding for prompt: "${prompt_text.substring(0, 50)}..."`);
      embedding = await generateEmbedding(prompt_text);
    }

    // Use find_similar_contexts as fallback if get_learned_recommendations doesn't exist
    // Check if function exists first
    const functionCheck = await db.query(
      `SELECT EXISTS (
        SELECT FROM pg_proc WHERE proname = 'get_learned_recommendations'
      ) as exists`
    );

    let result;
    if (functionCheck.rows[0].exists) {
      // Use the get_learned_recommendations function from migration 012
      result = await db.query(
        `SELECT * FROM get_learned_recommendations(
          $1::UUID,
          $2::vector(384),
          $3::TEXT,
          $4::INT
        )`,
        [userId, `[${embedding.join(',')}]`, prompt_text, limit]
      );
    } else {
      // Fallback to simple similarity search
      result = await db.query(
        `SELECT * FROM find_similar_contexts(
          $1::vector(384),
          $2::UUID,
          $3::INT,
          0.6,
          ARRAY[]::UUID[]
        )`,
        [`[${embedding.join(',')}]`, userId, limit]
      );
    }

    return res.json(success({ recommendations: result.rows }));
  } catch (err) {
    console.error('Get recommendations error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/layers/:id/similar
 * Find contexts similar to a specific context
 */
export async function findSimilar(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      limit = 10,
      min_similarity = 0.7
    } = req.query;

    // Verify ownership
    const contextCheck = await db.query(
      `SELECT id, name FROM context_layers WHERE id = $1 AND deleted_at IS NULL`,
      [contextId]
    );

    if (contextCheck.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    // Get embedding from context_embeddings table
    const embeddingResult = await db.query(
      `SELECT embedding FROM context_embeddings WHERE context_id = $1`,
      [contextId]
    );

    if (embeddingResult.rows.length === 0 || !embeddingResult.rows[0].embedding) {
      return res.json(success({
        similar: [],
        message: 'This context does not have an embedding yet. Please trigger embedding generation.'
      }));
    }

    const embedding = embeddingResult.rows[0].embedding;

    // Find similar contexts using the migration function
    const result = await db.query(
      `SELECT * FROM find_similar_contexts(
        $1::vector(384),
        $2::UUID,
        $3::INT,
        $4::DECIMAL,
        ARRAY[$5]::UUID[]
      )`,
      [embedding, userId, parseInt(limit), parseFloat(min_similarity), contextId]
    );

    return res.json(success({ similar: result.rows }));
  } catch (err) {
    console.error('Find similar error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/effectiveness
 * Get effectiveness metrics for contexts
 */
export async function getEffectivenessMetrics(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { min_usage_count = 5 } = req.query;

    // Use the get_context_effectiveness function from migration
    const result = await db.query(
      `SELECT * FROM get_context_effectiveness($1::UUID, $2::INT)`,
      [userId, parseInt(min_usage_count)]
    );

    return res.json(success({ metrics: result.rows }));
  } catch (err) {
    console.error('Get effectiveness metrics error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/track-usage
 * Track context usage for learning
 */
export async function trackUsage(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      session_id,
      prompt_text,
      prompt_embedding = null,
      context_ids,
      total_tokens,
      ai_model = 'unknown',
      completion_tokens = 0,
      user_rating = null,
      user_edited_output = false,
      success = null,
      platform = 'web'
    } = req.body;

    // Validation
    if (!session_id || !prompt_text || !context_ids || !Array.isArray(context_ids)) {
      return res.status(400).json(error('session_id, prompt_text, and context_ids (array) are required'));
    }

    // Generate embedding for prompt text if not provided
    let embedding = prompt_embedding;
    if (!embedding && prompt_text) {
      try {
        embedding = await generateEmbedding(prompt_text);
      } catch (err) {
        console.warn('⚠️  [Track Usage] Failed to generate prompt embedding:', err.message);
        embedding = null;
      }
    }

    // Insert usage session
    const result = await db.query(
      `INSERT INTO context_usage_sessions (
        user_id, session_id, prompt_text, prompt_embedding, context_ids,
        total_tokens, ai_model, completion_tokens, user_rating,
        user_edited_output, success, platform
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        userId, session_id, prompt_text,
        embedding ? `[${embedding.join(',')}]` : null,
        context_ids, total_tokens, ai_model, completion_tokens,
        user_rating, user_edited_output, success, platform
      ]
    );

    // Update context usage counts
    await db.query(
      `UPDATE context_layers
       SET usage_count = usage_count + 1,
           last_used_at = NOW()
       WHERE id = ANY($1) AND user_id = $2`,
      [context_ids, userId]
    );

    return res.status(201).json(success({
      tracked: true,
      session: result.rows[0]
    }));
  } catch (err) {
    console.error('Track usage error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/associations
 * Get frequently paired contexts
 */
export async function getAssociations(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { context_id, limit = 10 } = req.query;

    if (!context_id) {
      return res.status(400).json(error('context_id is required'));
    }

    // Use the get_context_associations function from migration
    const result = await db.query(
      `SELECT * FROM get_context_associations($1::UUID, $2::UUID, $3::INT)`,
      [context_id, userId, parseInt(limit)]
    );

    return res.json(success({ associations: result.rows }));
  } catch (err) {
    console.error('Get associations error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/layers/:id/generate-embedding
 * Queue context for embedding generation
 */
export async function queueEmbeddingGeneration(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { priority = 5 } = req.body;

    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [contextId, userId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    // Add to queue using the migration table name
    const result = await db.query(
      `INSERT INTO embedding_queue (resource_type, resource_id, priority, status)
       VALUES ('context', $1, $2, 'pending')
       ON CONFLICT (resource_type, resource_id, status)
       DO UPDATE SET priority = $2, retry_count = 0
       RETURNING *`,
      [contextId, priority]
    );

    return res.status(201).json(success({
      queued: true,
      queue_item: result.rows[0]
    }));
  } catch (err) {
    console.error('Queue embedding generation error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/hybrid-search
 * Hybrid search combining full-text and semantic similarity
 */
export async function hybridSearch(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      query_text,
      query_embedding = null,
      limit = 10,
      semantic_weight = 0.7
    } = req.body;

    if (!query_text) {
      return res.status(400).json(error('query_text is required'));
    }

    // Generate embedding from query_text if not provided
    let embedding = query_embedding;
    if (!embedding && query_text) {
      console.log(`🔍 [Hybrid Search] Generating embedding for query: "${query_text.substring(0, 50)}..."`);
      embedding = await generateEmbedding(query_text);
    }

    if (!embedding) {
      return res.status(500).json(error('Failed to generate embedding'));
    }

    // Use the hybrid_search_contexts function from migration
    const result = await db.query(
      `SELECT * FROM hybrid_search_contexts(
        $1::TEXT,
        $2::vector(384),
        $3::UUID,
        $4::INT,
        $5::DECIMAL
      )`,
      [query_text, `[${embedding.join(',')}]`, userId, limit, semantic_weight]
    );

    return res.json(success({ results: result.rows }));
  } catch (err) {
    console.error('Hybrid search error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
