/**
 * Smart Context Auto-Composition Handler
 *
 * Automatically composes optimal context combinations based on user goals
 * Uses AI and embeddings to suggest the best contexts for a given task
 *
 * @module handlers/contexts/auto_composition
 */

import { db } from '../../utils/database.js';
import { getUserId } from '../../utils/auth.js';
import { success, error } from '../../utils/responses.js';
import { generateEmbedding } from '../../services/localEmbeddingService.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/contexts/auto-compose
 * Generate optimal context composition based on user goal
 *
 * Body:
 * - goal: Natural language description of what user wants to accomplish
 * - maxContexts: Maximum contexts to include (default 10)
 * - minSimilarity: Minimum similarity threshold (default 0.65)
 * - targetTokenBudget: Target token budget (default 4000)
 * - includeExplanations: Include reasoning (default true)
 * - userPreferences: User preference weights (optional)
 * - constraints: Composition constraints (optional)
 */
export async function autoComposeContexts(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      goal,
      maxContexts = 10,
      minSimilarity = 0.65,
      targetTokenBudget = 4000,
      includeExplanations = true,
      userPreferences = {},
      constraints = {}
    } = req.body;

    if (!goal || goal.trim().length === 0) {
      return res.status(400).json(error('goal is required'));
    }

    const startTime = Date.now();
    const compositionId = uuidv4();

    // Generate embedding for the goal
    const { embedding } = await generateEmbedding(goal);

    // Get candidate contexts with scoring
    const candidates = await db.query(
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
           cl.content,
           (1 - (ce.embedding <=> $1::vector(384))) as semantic_similarity,
           -- Diversity score: prefer different layer types
           ROW_NUMBER() OVER (PARTITION BY cl.layer_type ORDER BY (1 - (ce.embedding <=> $1::vector(384))) DESC) as type_rank,
           -- Recency and usage scores
           CASE
             WHEN cl.last_used_at > NOW() - INTERVAL '7 days' THEN 0.2
             WHEN cl.last_used_at > NOW() - INTERVAL '30 days' THEN 0.1
             ELSE 0
           END as recency_score,
           LEAST(cl.usage_count::decimal / 100, 0.15) as usage_score,
           cl.priority::decimal / 50 as priority_score
         FROM context_layers cl
         INNER JOIN context_embeddings ce ON ce.context_id = cl.context_id
         WHERE cl.user_id = $2
           AND cl.is_active = true
           AND (1 - (ce.embedding <=> $1::vector(384))) >= $3
       )
       SELECT
         context_id,
         name,
         layer_type,
         description,
         priority,
         token_count,
         content,
         semantic_similarity,
         recency_score,
         usage_score,
         priority_score,
         type_rank,
         -- Combined score with weights
         (
           semantic_similarity * 0.5 +
           recency_score +
           usage_score +
           priority_score +
           -- Bonus for diversity (first of each type gets boost)
           CASE WHEN type_rank = 1 THEN 0.1 ELSE 0 END
         ) as composite_score
       FROM context_scores
       ORDER BY composite_score DESC, semantic_similarity DESC
       LIMIT $4 * 2`, // Get 2x candidates for better selection
      [
        `[${embedding.join(',')}]`,
        userId,
        minSimilarity,
        maxContexts
      ]
    );

    if (candidates.rows.length === 0) {
      return res.json(success({
        composition_id: compositionId,
        goal,
        compositions: [],
        message: 'No suitable contexts found for this goal. Try creating more contexts or lowering the similarity threshold.',
        total_time_ms: Date.now() - startTime
      }));
    }

    // Select optimal contexts within token budget
    const selectedContexts = selectOptimalContexts(
      candidates.rows,
      targetTokenBudget,
      maxContexts,
      constraints
    );

    // Resolve dependencies for selected contexts
    const contextIds = selectedContexts.map(c => c.context_id);
    const dependencies = await resolveDependencies(contextIds, userId);

    // Check for conflicts
    const conflicts = await checkConflicts(contextIds, userId);

    // Calculate final composition details
    const totalTokens = selectedContexts.reduce((sum, c) => sum + c.token_count, 0);
    const composedContent = selectedContexts
      .map(c => `# ${c.name}\n\n${c.content}`)
      .join('\n\n---\n\n');

    // Generate explanations if requested
    let explanations = null;
    if (includeExplanations) {
      explanations = {
        why_selected: selectedContexts.map(c => ({
          context_id: c.context_id,
          name: c.name,
          reason: generateSelectionReason(c)
        })),
        composition_strategy: determineStrategy(selectedContexts, targetTokenBudget),
        optimization_notes: generateOptimizationNotes(
          selectedContexts,
          candidates.rows.length,
          totalTokens,
          targetTokenBudget
        )
      };
    }

    // Save composition to database
    await db.query(
      `INSERT INTO auto_compositions
       (composition_id, user_id, goal_text, selected_contexts, total_tokens,
        goal_embedding, composition_quality_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        compositionId,
        userId,
        goal,
        contextIds,
        totalTokens,
        `[${embedding.join(',')}]`,
        calculateQualityScore(selectedContexts, totalTokens, targetTokenBudget)
      ]
    );

    const result = {
      composition_id: compositionId,
      goal,
      compositions: [{
        contexts: selectedContexts.map(c => ({
          context_id: c.context_id,
          name: c.name,
          layer_type: c.layer_type,
          description: c.description,
          token_count: c.token_count,
          scores: {
            semantic_similarity: parseFloat(c.semantic_similarity),
            composite_score: parseFloat(c.composite_score)
          },
          order: selectedContexts.indexOf(c) + 1
        })),
        total_tokens: totalTokens,
        token_budget_usage: ((totalTokens / targetTokenBudget) * 100).toFixed(1),
        context_count: selectedContexts.length,
        composed_content: composedContent,
        dependencies: dependencies,
        conflicts: conflicts,
        quality_score: calculateQualityScore(selectedContexts, totalTokens, targetTokenBudget)
      }],
      explanations,
      metadata: {
        total_candidates: candidates.rows.length,
        selection_algorithm: 'greedy_budget_aware',
        min_similarity_used: minSimilarity
      },
      total_time_ms: Date.now() - startTime
    };

    return res.json(success(result));
  } catch (err) {
    console.error('Auto-compose error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/auto-compose/feedback
 * Submit feedback on auto-composition results
 */
export async function submitAutoComposeFeedback(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      compositionId,
      wasAccepted,
      wasModified,
      userRating,
      actualContextIds,
      feedbackText
    } = req.body;

    if (!compositionId) {
      return res.status(400).json(error('compositionId is required'));
    }

    // Update composition with feedback
    await db.query(
      `UPDATE auto_compositions
       SET was_accepted = $1,
           was_modified = $2,
           user_rating = $3,
           actual_contexts_used = $4,
           feedback_text = $5,
           feedback_submitted_at = NOW()
       WHERE composition_id = $6 AND user_id = $7`,
      [
        wasAccepted,
        wasModified,
        userRating,
        actualContextIds || [],
        feedbackText,
        compositionId,
        userId
      ]
    );

    return res.json(success({
      message: 'Feedback submitted successfully',
      composition_id: compositionId
    }));
  } catch (err) {
    console.error('Feedback submission error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/auto-compose/history
 * Get auto-composition history for the current user
 */
export async function getAutoComposeHistory(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { limit = 20, offset = 0 } = req.query;

    const history = await db.query(
      `SELECT
         ac.composition_id,
         ac.goal_text,
         ac.selected_contexts,
         ac.total_tokens,
         ac.was_accepted,
         ac.was_modified,
         ac.user_rating,
         ac.composition_quality_score,
         ac.created_at,
         ac.feedback_submitted_at,
         -- Get context names
         ARRAY_AGG(cl.name) as context_names
       FROM auto_compositions ac
       LEFT JOIN context_layers cl ON cl.context_id = ANY(ac.selected_contexts)
       WHERE ac.user_id = $1
       GROUP BY ac.composition_id, ac.goal_text, ac.selected_contexts, ac.total_tokens,
                ac.was_accepted, ac.was_modified, ac.user_rating, ac.composition_quality_score,
                ac.created_at, ac.feedback_submitted_at
       ORDER BY ac.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    const formattedHistory = history.rows.map(row => ({
      composition_id: row.composition_id,
      goal: row.goal_text,
      context_count: row.selected_contexts.length,
      context_names: row.context_names,
      total_tokens: row.total_tokens,
      quality_score: parseFloat(row.composition_quality_score),
      feedback: {
        was_accepted: row.was_accepted,
        was_modified: row.was_modified,
        user_rating: row.user_rating,
        submitted_at: row.feedback_submitted_at
      },
      created_at: row.created_at
    }));

    return res.json(success({
      history: formattedHistory,
      total: formattedHistory.length,
      limit: parseInt(limit),
      offset: parseInt(offset)
    }));
  } catch (err) {
    console.error('Get history error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

// Helper functions

function selectOptimalContexts(candidates, tokenBudget, maxContexts, constraints) {
  const selected = [];
  let currentTokens = 0;

  // Greedy selection with budget awareness
  for (const candidate of candidates) {
    if (selected.length >= maxContexts) break;
    if (currentTokens + candidate.token_count > tokenBudget * 1.1) continue; // Allow 10% over

    selected.push(candidate);
    currentTokens += candidate.token_count;

    if (currentTokens >= tokenBudget * 0.9) break; // Stop at 90% if we're close
  }

  return selected;
}

async function resolveDependencies(contextIds, userId) {
  // Query relationships to find dependencies
  const deps = await db.query(
    `SELECT DISTINCT
       cr.source_id,
       cr.target_id,
       cr.relationship_type
     FROM context_relationships cr
     WHERE cr.source_id = ANY($1)
       AND cr.relationship_type IN ('requires', 'extends')
       AND EXISTS (
         SELECT 1 FROM context_layers cl
         WHERE cl.context_id = cr.source_id AND cl.user_id = $2
       )`,
    [contextIds, userId]
  );

  return deps.rows;
}

async function checkConflicts(contextIds, userId) {
  const conflicts = await db.query(
    `SELECT DISTINCT
       cr.source_id,
       cr.target_id,
       cr.relationship_type,
       cr.metadata->>'reason' as conflict_reason
     FROM context_relationships cr
     WHERE (cr.source_id = ANY($1) OR cr.target_id = ANY($1))
       AND cr.relationship_type = 'conflicts'
       AND cr.source_id = ANY($1)
       AND cr.target_id = ANY($1)`,
    [contextIds]
  );

  return conflicts.rows;
}

function generateSelectionReason(context) {
  if (context.semantic_similarity > 0.8) {
    return `Highly relevant to your goal (${(context.semantic_similarity * 100).toFixed(0)}% match)`;
  } else if (context.semantic_similarity > 0.7) {
    return `Good semantic match (${(context.semantic_similarity * 100).toFixed(0)}% match)`;
  } else if (context.priority > 7) {
    return 'High priority context';
  } else if (context.usage_score > 0.1) {
    return 'Frequently used context';
  } else {
    return 'Related to your goal';
  }
}

function determineStrategy(selectedContexts, tokenBudget) {
  const totalTokens = selectedContexts.reduce((sum, c) => sum + c.token_count, 0);
  const usage = (totalTokens / tokenBudget) * 100;

  if (usage > 90) {
    return 'Maximized context within budget';
  } else if (usage > 70) {
    return 'Balanced selection for quality and coverage';
  } else {
    return 'Focused selection of most relevant contexts';
  }
}

function generateOptimizationNotes(selectedContexts, totalCandidates, totalTokens, tokenBudget) {
  const notes = [];

  if (totalCandidates > selectedContexts.length * 2) {
    notes.push(`Filtered ${totalCandidates} candidates down to ${selectedContexts.length} optimal contexts`);
  }

  const usage = (totalTokens / tokenBudget) * 100;
  if (usage > 90) {
    notes.push(`Token budget ${usage.toFixed(0)}% utilized`);
  }

  const layerTypes = new Set(selectedContexts.map(c => c.layer_type));
  if (layerTypes.size > 1) {
    notes.push(`Diverse selection across ${layerTypes.size} context types`);
  }

  return notes;
}

function calculateQualityScore(selectedContexts, totalTokens, tokenBudget) {
  // Quality score based on:
  // 1. Average semantic similarity (40%)
  // 2. Token budget utilization (30%)
  // 3. Context diversity (30%)

  const avgSimilarity = selectedContexts.reduce((sum, c) => sum + c.semantic_similarity, 0) / selectedContexts.length;
  const budgetUtilization = Math.min(totalTokens / tokenBudget, 1);
  const layerTypes = new Set(selectedContexts.map(c => c.layer_type));
  const diversityScore = Math.min(layerTypes.size / 4, 1); // Assume 4 layer types

  const qualityScore = (avgSimilarity * 0.4) + (budgetUtilization * 0.3) + (diversityScore * 0.3);

  return qualityScore;
}

export default {
  autoComposeContexts,
  submitAutoComposeFeedback,
  getAutoComposeHistory
};
