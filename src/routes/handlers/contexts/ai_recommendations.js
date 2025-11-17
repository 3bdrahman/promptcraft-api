/**
 * AI-Powered Context Recommendations Handler
 *
 * Provides intelligent context recommendations based on user's prompt text
 *
 * @module handlers/contexts/ai_recommendations
 */

import { db } from '../../utils/database.js';
import { getUserId } from '../../utils/auth.js';
import { success, error } from '../../utils/responses.js';
import { generateEmbedding } from '../../services/localEmbeddingService.js';

/**
 * POST /api/contexts/recommend
 * Get AI-powered context recommendations for a prompt
 *
 * Body:
 * - prompt_text: The prompt text to analyze
 * - limit: Maximum recommendations (default 5)
 */
export async function getAIRecommendations(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      prompt_text,
      limit = 5
    } = req.body;

    if (!prompt_text || prompt_text.trim().length === 0) {
      return res.status(400).json(error('prompt_text is required'));
    }

    const startTime = Date.now();

    // Generate embedding for the prompt
    const { embedding } = await generateEmbedding(prompt_text);

    // Get context recommendations with multiple scoring factors
    const recommendations = await db.query(
      `WITH context_scores AS (
         SELECT
           cl.context_id,
           cl.name,
           cl.layer_type,
           cl.description,
           cl.priority,
           cl.token_count,
           cl.usage_count,
           cl.last_used_at,
           SUBSTRING(cl.content, 1, 200) as content_preview,
           (1 - (ce.embedding <=> $1::vector(384))) as semantic_similarity,
           -- Recency score: higher for recently used contexts
           CASE
             WHEN cl.last_used_at IS NULL THEN 0
             WHEN cl.last_used_at > NOW() - INTERVAL '1 day' THEN 0.3
             WHEN cl.last_used_at > NOW() - INTERVAL '7 days' THEN 0.2
             WHEN cl.last_used_at > NOW() - INTERVAL '30 days' THEN 0.1
             ELSE 0
           END as recency_score,
           -- Usage score: normalized usage count
           LEAST(cl.usage_count::decimal / 100, 0.2) as usage_score,
           -- Priority score
           cl.priority::decimal / 50 as priority_score
         FROM context_layers cl
         INNER JOIN context_embeddings ce ON ce.context_id = cl.context_id
         WHERE cl.user_id = $2
           AND cl.is_active = true
           AND (1 - (ce.embedding <=> $1::vector(384))) >= 0.5
       )
       SELECT
         context_id,
         name,
         layer_type,
         description,
         priority,
         token_count,
         usage_count,
         last_used_at,
         content_preview,
         semantic_similarity,
         recency_score,
         usage_score,
         priority_score,
         -- Combined score with weights
         (
           semantic_similarity * 0.5 +
           recency_score +
           usage_score +
           priority_score
         ) as recommendation_score,
         -- Explanation of why this was recommended
         CASE
           WHEN semantic_similarity > 0.8 THEN 'Highly relevant to your prompt'
           WHEN semantic_similarity > 0.7 THEN 'Semantically similar to your prompt'
           WHEN recency_score > 0.2 THEN 'Recently used context'
           WHEN usage_score > 0.1 THEN 'Frequently used context'
           ELSE 'Related to your prompt'
         END as recommendation_reason
       FROM context_scores
       ORDER BY recommendation_score DESC, semantic_similarity DESC
       LIMIT $3`,
      [
        `[${embedding.join(',')}]`,
        userId,
        limit
      ]
    );

    // Format recommendations
    const formattedRecommendations = recommendations.rows.map(row => ({
      context_id: row.context_id,
      name: row.name,
      layer_type: row.layer_type,
      description: row.description,
      priority: row.priority,
      token_count: row.token_count,
      content_preview: row.content_preview,
      scores: {
        semantic_similarity: parseFloat(row.semantic_similarity),
        recency_score: parseFloat(row.recency_score),
        usage_score: parseFloat(row.usage_score),
        priority_score: parseFloat(row.priority_score),
        recommendation_score: parseFloat(row.recommendation_score)
      },
      recommendation_reason: row.recommendation_reason,
      metadata: {
        usage_count: row.usage_count,
        last_used_at: row.last_used_at
      }
    }));

    const results = {
      prompt_text,
      recommendations: formattedRecommendations,
      total_recommendations: formattedRecommendations.length,
      total_time_ms: Date.now() - startTime
    };

    return res.json(success(results));
  } catch (err) {
    console.error('AI recommendations error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

export default {
  getAIRecommendations
};
