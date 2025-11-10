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

    // Verify ownership and get embedding
    const contextResult = await db.query(
      `SELECT id, name, embedding
       FROM context_layers
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [contextId, userId]
    );

    if (contextResult.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    const context = contextResult.rows[0];

    if (!context.embedding) {
      return res.json(success({
        similar: [],
        message: 'This context does not have an embedding yet. Please trigger embedding generation.'
      }));
    }

    // Find similar contexts
    const result = await db.query(
      `SELECT * FROM find_similar_contexts(
        $1::vector(384),
        $2::UUID,
        $3::INT,
        $4::DECIMAL,
        ARRAY[$5]::UUID[]
      )`,
      [context.embedding, userId, parseInt(limit), parseFloat(min_similarity), contextId]
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

    const { context_id = null } = req.query;

    let query;
    let params;

    if (context_id) {
      // Get effectiveness for specific context
      query = `
        SELECT
          cem.*,
          cl.name as context_name,
          cl.layer_type
        FROM context_effectiveness_metrics cem
        JOIN context_layers cl ON cem.context_id = cl.id
        WHERE cl.user_id = $1 AND cem.context_id = $2
      `;
      params = [userId, context_id];
    } else {
      // Get effectiveness for all user's contexts
      query = `
        SELECT
          cem.*,
          cl.name as context_name,
          cl.layer_type
        FROM context_effectiveness_metrics cem
        JOIN context_layers cl ON cem.context_id = cl.id
        WHERE cl.user_id = $1
        ORDER BY cem.total_uses DESC
        LIMIT 50
      `;
      params = [userId];
    }

    const result = await db.query(query, params);

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

    const { context_id = null, limit = 20 } = req.query;

    let query;
    let params;

    if (context_id) {
      // Get associations for specific context
      query = `
        SELECT
          ca.*,
          cl_a.name as context_a_name,
          cl_b.name as context_b_name
        FROM context_associations ca
        JOIN context_layers cl_a ON ca.context_a_id = cl_a.id
        JOIN context_layers cl_b ON ca.context_b_id = cl_b.id
        WHERE (ca.context_a_id = $1 OR ca.context_b_id = $1)
          AND cl_a.user_id = $2
          AND cl_b.user_id = $2
        ORDER BY ca.co_occurrence_count DESC
        LIMIT $3
      `;
      params = [context_id, userId, parseInt(limit)];
    } else {
      // Get top associations for user
      query = `
        SELECT
          ca.*,
          cl_a.name as context_a_name,
          cl_b.name as context_b_name
        FROM context_associations ca
        JOIN context_layers cl_a ON ca.context_a_id = cl_a.id
        JOIN context_layers cl_b ON ca.context_b_id = cl_b.id
        WHERE cl_a.user_id = $1 AND cl_b.user_id = $1
        ORDER BY ca.co_occurrence_count DESC
        LIMIT $2
      `;
      params = [userId, parseInt(limit)];
    }

    const result = await db.query(query, params);

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

    // Add to queue
    const result = await db.query(
      `INSERT INTO embedding_generation_queue (context_id, priority, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (context_id, status)
       DO UPDATE SET priority = $2, attempts = 0
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
