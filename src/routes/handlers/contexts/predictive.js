/**
 * Predictive Context Engine Handler
 *
 * ML-powered pattern learning that proactively suggests contexts based on:
 * - Time-based patterns (time of day, day of week)
 * - Activity patterns (frontend work, API development, etc.)
 * - Sequential patterns (contexts used together)
 * - Success patterns (combinations that led to successful sessions)
 *
 * @module handlers/contexts/predictive
 */

import { db } from '../../../utils/database.js';
import { getUserId } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';
import { generateEmbedding } from '../../../services/localEmbeddingService.js';

/**
 * POST /api/contexts/predictive/predict
 * Get predictive context suggestions
 *
 * Body:
 * - current_activity: (optional) Current activity description
 * - recent_contexts: (optional) Array of recently used context IDs
 * - time_context: (optional) Time-based context {hour, day_of_week}
 * - limit: Maximum predictions to return (default 8)
 */
export async function getPredictions(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      current_activity,
      recent_contexts = [],
      time_context,
      limit = 8
    } = req.body;

    const predictions = [];

    // 1. Time-based predictions
    if (time_context || !current_activity) {
      const now = new Date();
      const hour = time_context?.hour || now.getHours();
      const dayOfWeek = time_context?.day_of_week || now.getDay();

      const timeBasedPredictions = await getTimeBasedPredictions(
        userId,
        hour,
        dayOfWeek,
        Math.ceil(limit / 3)
      );

      predictions.push(...timeBasedPredictions);
    }

    // 2. Activity-based predictions
    if (current_activity) {
      const activityPredictions = await getActivityBasedPredictions(
        userId,
        current_activity,
        Math.ceil(limit / 3)
      );

      predictions.push(...activityPredictions);
    }

    // 3. Sequential predictions (what usually comes next)
    if (recent_contexts.length > 0) {
      const sequentialPredictions = await getSequentialPredictions(
        userId,
        recent_contexts,
        Math.ceil(limit / 3)
      );

      predictions.push(...sequentialPredictions);
    }

    // 4. If no specific context, use frequency-based predictions
    if (predictions.length === 0) {
      const frequencyPredictions = await getFrequencyBasedPredictions(
        userId,
        limit
      );

      predictions.push(...frequencyPredictions);
    }

    // Deduplicate and rank predictions
    const uniquePredictions = deduplicateAndRank(predictions, limit);

    return res.json(success({
      predictions: uniquePredictions,
      total: uniquePredictions.length,
      sources: {
        time_based: predictions.filter(p => p.source === 'time').length,
        activity_based: predictions.filter(p => p.source === 'activity').length,
        sequential: predictions.filter(p => p.source === 'sequential').length,
        frequency: predictions.filter(p => p.source === 'frequency').length
      }
    }));

  } catch (err) {
    console.error('Get predictions error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/predictive/track
 * Track context usage for pattern learning
 *
 * Body:
 * - context_id: Context that was used
 * - activity_type: Type of activity
 * - success: Whether the session was successful (optional)
 * - duration: Session duration in seconds (optional)
 * - related_contexts: Other contexts used in same session (optional)
 */
export async function trackUsage(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      context_id,
      activity_type,
      success: wasSuccessful = true,
      duration,
      related_contexts = []
    } = req.body;

    if (!context_id) {
      return res.status(400).json(error('context_id is required'));
    }

    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();

    // Record usage event
    await db.query(
      `INSERT INTO context_usage_events
       (user_id, context_id, activity_type, timestamp, success, duration, metadata)
       VALUES ($1, $2, $3, NOW(), $4, $5, $6)`,
      [
        userId,
        context_id,
        activity_type || 'general',
        wasSuccessful,
        duration,
        JSON.stringify({
          hour,
          day_of_week: dayOfWeek,
          related_contexts
        })
      ]
    );

    // Update context usage count
    await db.query(
      `UPDATE context_layers
       SET usage_count = COALESCE(usage_count, 0) + 1,
           last_used_at = NOW()
       WHERE id = $1`,
      [context_id]
    );

    return res.json(success({
      tracked: true,
      context_id,
      timestamp: now.toISOString()
    }));

  } catch (err) {
    console.error('Track usage error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/predictive/patterns
 * Get user's usage patterns and analytics
 *
 * Query params:
 * - time_range: Time range for analysis ('7d', '30d', '90d', 'all')
 * - group_by: Grouping ('hour', 'day_of_week', 'activity')
 */
export async function getPatterns(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      time_range = '30d',
      group_by = 'activity'
    } = req.query;

    // Parse time range
    const daysBack = parseInt(time_range) || 30;

    // Get usage patterns
    let patterns;

    if (group_by === 'hour') {
      patterns = await getHourlyPatterns(userId, daysBack);
    } else if (group_by === 'day_of_week') {
      patterns = await getDayOfWeekPatterns(userId, daysBack);
    } else if (group_by === 'activity') {
      patterns = await getActivityPatterns(userId, daysBack);
    } else {
      return res.status(400).json(error('Invalid group_by parameter'));
    }

    // Get most successful combinations
    const successfulCombinations = await getSuccessfulCombinations(userId, daysBack);

    // Get context usage frequency
    const topContexts = await getTopContexts(userId, daysBack);

    return res.json(success({
      time_range,
      group_by,
      patterns,
      successful_combinations: successfulCombinations,
      top_contexts: topContexts
    }));

  } catch (err) {
    console.error('Get patterns error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * Get time-based predictions
 */
async function getTimeBasedPredictions(userId, hour, dayOfWeek, limit) {
  const result = await db.query(
    `SELECT
       cl.id as context_id,
       cl.name,
       cl.description,
       cl.layer_type,
       cl.tags,
       COUNT(*) as usage_count,
       AVG(CASE WHEN cue.success THEN 1 ELSE 0 END) as success_rate
     FROM context_usage_events cue
     JOIN context_layers cl ON cl.id = cue.context_id
     WHERE cue.user_id = $1
       AND EXTRACT(HOUR FROM cue.timestamp) = $2
       AND EXTRACT(DOW FROM cue.timestamp) = $3
       AND cue.timestamp > NOW() - INTERVAL '30 days'
     GROUP BY cl.id, cl.name, cl.description, cl.layer_type, cl.tags
     ORDER BY usage_count DESC, success_rate DESC
     LIMIT $4`,
    [userId, hour, dayOfWeek, limit]
  );

  return result.rows.map(row => ({
    context_id: row.context_id,
    name: row.name,
    description: row.description,
    layer_type: row.layer_type,
    tags: row.tags,
    confidence: Math.min(0.95, row.usage_count / 10 + row.success_rate / 2),
    reason: `Often used on ${getDayName(dayOfWeek)} around ${hour}:00`,
    source: 'time',
    metadata: {
      usage_count: parseInt(row.usage_count),
      success_rate: parseFloat(row.success_rate)
    }
  }));
}

/**
 * Get activity-based predictions
 */
async function getActivityBasedPredictions(userId, activity, limit) {
  // Generate embedding for activity
  const { embedding } = await generateEmbedding(activity);

  const result = await db.query(
    `SELECT
       cl.id as context_id,
       cl.name,
       cl.description,
       cl.layer_type,
       cl.tags,
       COUNT(*) as usage_count,
       AVG(CASE WHEN cue.success THEN 1 ELSE 0 END) as success_rate
     FROM context_usage_events cue
     JOIN context_layers cl ON cl.id = cue.context_id
     WHERE cue.user_id = $1
       AND cue.activity_type IS NOT NULL
       AND cue.timestamp > NOW() - INTERVAL '90 days'
     GROUP BY cl.id, cl.name, cl.description, cl.layer_type, cl.tags
     ORDER BY usage_count DESC, success_rate DESC
     LIMIT $2`,
    [userId, limit * 2]
  );

  // Score contexts based on semantic similarity to current activity
  const scoredContexts = await Promise.all(
    result.rows.map(async (row) => {
      // Get context embedding
      const embeddingResult = await db.query(
        `SELECT embedding FROM context_embeddings WHERE context_id = $1`,
        [row.context_id]
      );

      let similarityScore = 0.5; // Default
      if (embeddingResult.rows.length > 0) {
        // Calculate similarity using PostgreSQL vector operations
        const simResult = await db.query(
          `SELECT 1 - (embedding <=> $1::vector(384)) as similarity
           FROM context_embeddings
           WHERE context_id = $2`,
          [`[${embedding.join(',')}]`, row.context_id]
        );

        if (simResult.rows.length > 0) {
          similarityScore = parseFloat(simResult.rows[0].similarity);
        }
      }

      const confidence = (similarityScore * 0.6) + (row.success_rate * 0.4);

      return {
        context_id: row.context_id,
        name: row.name,
        description: row.description,
        layer_type: row.layer_type,
        tags: row.tags,
        confidence,
        reason: `Relevant for "${activity}" based on past usage`,
        source: 'activity',
        metadata: {
          usage_count: parseInt(row.usage_count),
          success_rate: parseFloat(row.success_rate),
          similarity: similarityScore
        }
      };
    })
  );

  // Sort by confidence and return top results
  return scoredContexts
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/**
 * Get sequential predictions (what comes next)
 */
async function getSequentialPredictions(userId, recentContextIds, limit) {
  if (recentContextIds.length === 0) return [];

  // Find contexts that were used after the recent contexts
  const result = await db.query(
    `WITH recent_sessions AS (
       SELECT DISTINCT
         DATE_TRUNC('minute', timestamp) as session_time
       FROM context_usage_events
       WHERE user_id = $1
         AND context_id = ANY($2::UUID[])
         AND timestamp > NOW() - INTERVAL '90 days'
     )
     SELECT
       cl.id as context_id,
       cl.name,
       cl.description,
       cl.layer_type,
       cl.tags,
       COUNT(*) as follow_count,
       AVG(CASE WHEN cue.success THEN 1 ELSE 0 END) as success_rate
     FROM context_usage_events cue
     JOIN context_layers cl ON cl.id = cue.context_id
     JOIN recent_sessions rs ON DATE_TRUNC('minute', cue.timestamp) = rs.session_time
     WHERE cue.user_id = $1
       AND cue.context_id != ALL($2::UUID[])
     GROUP BY cl.id, cl.name, cl.description, cl.layer_type, cl.tags
     ORDER BY follow_count DESC, success_rate DESC
     LIMIT $3`,
    [userId, recentContextIds, limit]
  );

  return result.rows.map(row => ({
    context_id: row.context_id,
    name: row.name,
    description: row.description,
    layer_type: row.layer_type,
    tags: row.tags,
    confidence: Math.min(0.9, row.follow_count / 5 + row.success_rate / 2),
    reason: 'Often used after your recent contexts',
    source: 'sequential',
    metadata: {
      follow_count: parseInt(row.follow_count),
      success_rate: parseFloat(row.success_rate)
    }
  }));
}

/**
 * Get frequency-based predictions
 */
async function getFrequencyBasedPredictions(userId, limit) {
  const result = await db.query(
    `SELECT
       cl.id as context_id,
       cl.name,
       cl.description,
       cl.layer_type,
       cl.tags,
       cl.usage_count,
       cl.last_used_at,
       COUNT(cue.id) as recent_uses,
       AVG(CASE WHEN cue.success THEN 1 ELSE 0 END) as success_rate
     FROM context_layers cl
     LEFT JOIN context_usage_events cue ON cue.context_id = cl.id
       AND cue.timestamp > NOW() - INTERVAL '30 days'
     WHERE cl.user_id = $1
       AND cl.is_active = true
     GROUP BY cl.id, cl.name, cl.description, cl.layer_type, cl.tags, cl.usage_count, cl.last_used_at
     HAVING COUNT(cue.id) > 0
     ORDER BY recent_uses DESC, cl.usage_count DESC
     LIMIT $2`,
    [userId, limit]
  );

  return result.rows.map(row => ({
    context_id: row.context_id,
    name: row.name,
    description: row.description,
    layer_type: row.layer_type,
    tags: row.tags,
    confidence: Math.min(0.85, row.recent_uses / 20),
    reason: 'Frequently used recently',
    source: 'frequency',
    metadata: {
      usage_count: row.usage_count,
      recent_uses: parseInt(row.recent_uses),
      success_rate: parseFloat(row.success_rate || 0),
      last_used: row.last_used_at
    }
  }));
}

/**
 * Deduplicate and rank predictions
 */
function deduplicateAndRank(predictions, limit) {
  const seen = new Set();
  const unique = [];

  // Sort by confidence first
  predictions.sort((a, b) => b.confidence - a.confidence);

  for (const pred of predictions) {
    if (!seen.has(pred.context_id)) {
      seen.add(pred.context_id);
      unique.push(pred);

      if (unique.length >= limit) break;
    }
  }

  return unique;
}

/**
 * Helper functions for pattern analysis
 */

async function getHourlyPatterns(userId, daysBack) {
  const result = await db.query(
    `SELECT
       EXTRACT(HOUR FROM timestamp) as hour,
       COUNT(*) as usage_count,
       COUNT(DISTINCT context_id) as unique_contexts,
       AVG(CASE WHEN success THEN 1 ELSE 0 END) as success_rate
     FROM context_usage_events
     WHERE user_id = $1
       AND timestamp > NOW() - INTERVAL '${daysBack} days'
     GROUP BY EXTRACT(HOUR FROM timestamp)
     ORDER BY hour`,
    [userId]
  );

  return result.rows.map(row => ({
    hour: parseInt(row.hour),
    usage_count: parseInt(row.usage_count),
    unique_contexts: parseInt(row.unique_contexts),
    success_rate: parseFloat(row.success_rate)
  }));
}

async function getDayOfWeekPatterns(userId, daysBack) {
  const result = await db.query(
    `SELECT
       EXTRACT(DOW FROM timestamp) as day_of_week,
       COUNT(*) as usage_count,
       COUNT(DISTINCT context_id) as unique_contexts,
       AVG(CASE WHEN success THEN 1 ELSE 0 END) as success_rate
     FROM context_usage_events
     WHERE user_id = $1
       AND timestamp > NOW() - INTERVAL '${daysBack} days'
     GROUP BY EXTRACT(DOW FROM timestamp)
     ORDER BY day_of_week`,
    [userId]
  );

  return result.rows.map(row => ({
    day_of_week: parseInt(row.day_of_week),
    day_name: getDayName(parseInt(row.day_of_week)),
    usage_count: parseInt(row.usage_count),
    unique_contexts: parseInt(row.unique_contexts),
    success_rate: parseFloat(row.success_rate)
  }));
}

async function getActivityPatterns(userId, daysBack) {
  const result = await db.query(
    `SELECT
       activity_type,
       COUNT(*) as usage_count,
       COUNT(DISTINCT context_id) as unique_contexts,
       AVG(CASE WHEN success THEN 1 ELSE 0 END) as success_rate,
       AVG(duration) as avg_duration
     FROM context_usage_events
     WHERE user_id = $1
       AND activity_type IS NOT NULL
       AND timestamp > NOW() - INTERVAL '${daysBack} days'
     GROUP BY activity_type
     ORDER BY usage_count DESC`,
    [userId]
  );

  return result.rows.map(row => ({
    activity_type: row.activity_type,
    usage_count: parseInt(row.usage_count),
    unique_contexts: parseInt(row.unique_contexts),
    success_rate: parseFloat(row.success_rate),
    avg_duration: row.avg_duration ? parseInt(row.avg_duration) : null
  }));
}

async function getSuccessfulCombinations(userId, daysBack) {
  // This is a simplified version - in production, use proper co-occurrence analysis
  const result = await db.query(
    `WITH session_contexts AS (
       SELECT
         DATE_TRUNC('minute', timestamp) as session,
         ARRAY_AGG(DISTINCT context_id) as contexts,
         AVG(CASE WHEN success THEN 1 ELSE 0 END) as session_success
       FROM context_usage_events
       WHERE user_id = $1
         AND timestamp > NOW() - INTERVAL '${daysBack} days'
       GROUP BY DATE_TRUNC('minute', timestamp)
       HAVING COUNT(DISTINCT context_id) >= 2
     )
     SELECT
       contexts,
       COUNT(*) as frequency,
       AVG(session_success) as success_rate
     FROM session_contexts
     WHERE session_success >= 0.8
     GROUP BY contexts
     ORDER BY frequency DESC, success_rate DESC
     LIMIT 10`,
    [userId]
  );

  return result.rows.map(row => ({
    context_ids: row.contexts,
    frequency: parseInt(row.frequency),
    success_rate: parseFloat(row.success_rate)
  }));
}

async function getTopContexts(userId, daysBack) {
  const result = await db.query(
    `SELECT
       cl.id as context_id,
       cl.name,
       COUNT(*) as usage_count,
       AVG(CASE WHEN cue.success THEN 1 ELSE 0 END) as success_rate,
       MAX(cue.timestamp) as last_used
     FROM context_usage_events cue
     JOIN context_layers cl ON cl.id = cue.context_id
     WHERE cue.user_id = $1
       AND cue.timestamp > NOW() - INTERVAL '${daysBack} days'
     GROUP BY cl.id, cl.name
     ORDER BY usage_count DESC
     LIMIT 10`,
    [userId]
  );

  return result.rows.map(row => ({
    context_id: row.context_id,
    name: row.name,
    usage_count: parseInt(row.usage_count),
    success_rate: parseFloat(row.success_rate),
    last_used: row.last_used
  }));
}

function getDayName(dayOfWeek) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[dayOfWeek] || 'Unknown';
}

export default {
  getPredictions,
  trackUsage,
  getPatterns
};
