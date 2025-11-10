/**
 * Token Usage Tracking Utilities
 * Centralized token tracking and limit enforcement
 */

import { db } from './database.js';

/**
 * Log token usage for a user operation
 * @param {string} userId - User ID
 * @param {Object} usage - Usage details
 * @param {string} usage.operationType - Type of operation (template, context, ai_suggestion, api_call, other)
 * @param {string} [usage.resourceId] - Optional resource ID
 * @param {number} usage.inputTokens - Input tokens used
 * @param {number} usage.outputTokens - Output tokens used
 * @param {boolean} [usage.success=true] - Whether operation succeeded
 * @param {string} [usage.errorMessage] - Error message if failed
 * @param {Object} [usage.metadata={}] - Additional metadata
 * @returns {Promise<Object>} Usage record
 */
export async function logTokenUsage(userId, usage) {
  try {
    const {
      operationType,
      resourceId = null,
      inputTokens,
      outputTokens,
      success = true,
      errorMessage = null,
      metadata = {}
    } = usage;

    // Validate operation type
    const validOperations = ['template', 'context', 'ai_suggestion', 'api_call', 'other'];
    if (!validOperations.includes(operationType)) {
      throw new Error(`Invalid operation type: ${operationType}`);
    }

    // Calculate cost (example pricing: $0.00001 per token)
    const totalTokens = inputTokens + outputTokens;
    const costUsd = (totalTokens * 0.00001).toFixed(6);

    const result = await db.query(
      `INSERT INTO token_usage (
        user_id, operation_type, resource_id, input_tokens,
        output_tokens, cost_usd, success, error_message, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        userId,
        operationType,
        resourceId,
        inputTokens,
        outputTokens,
        costUsd,
        success,
        errorMessage,
        metadata
      ]
    );

    return {
      success: true,
      data: result.rows[0]
    };
  } catch (err) {
    console.error('Token usage logging error:', err);
    // Don't fail the main operation if logging fails
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Check if user has exceeded their token limit
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Limit status
 */
export async function checkTokenLimit(userId) {
  try {
    const result = await db.query(
      'SELECT check_token_limit($1) as limit_exceeded',
      [userId]
    );

    const limitExceeded = result.rows[0]?.limit_exceeded || false;

    // Get detailed info
    const summaryResult = await db.query(
      `SELECT
        tus.current_month_tokens,
        tus.monthly_limit,
        st.name as tier_name
      FROM token_usage_summary tus
      JOIN users u ON tus.user_id = u.id
      JOIN subscription_tiers st ON u.current_tier = st.id
      WHERE tus.user_id = $1`,
      [userId]
    );

    if (summaryResult.rows.length === 0) {
      return {
        allowed: true,
        limitExceeded: false,
        message: 'No usage data found'
      };
    }

    const summary = summaryResult.rows[0];
    const remaining = summary.monthly_limit
      ? Math.max(0, summary.monthly_limit - summary.current_month_tokens)
      : null; // null = unlimited

    return {
      allowed: !limitExceeded,
      limitExceeded,
      currentTokens: summary.current_month_tokens,
      monthlyLimit: summary.monthly_limit,
      remaining,
      tierName: summary.tier_name,
      message: limitExceeded
        ? `Token limit exceeded (${summary.current_month_tokens}/${summary.monthly_limit}). Upgrade your plan.`
        : summary.monthly_limit
        ? `${remaining} tokens remaining this month`
        : 'Unlimited tokens'
    };
  } catch (err) {
    console.error('Token limit check error:', err);
    // Fail open to avoid blocking users
    return {
      allowed: true,
      limitExceeded: false,
      error: err.message
    };
  }
}

/**
 * Get remaining tokens for a user
 * @param {string} userId - User ID
 * @returns {Promise<number|null>} Remaining tokens (null = unlimited)
 */
export async function getRemainingTokens(userId) {
  try {
    const result = await db.query(
      'SELECT get_remaining_tokens($1) as remaining',
      [userId]
    );

    return result.rows[0]?.remaining || null;
  } catch (err) {
    console.error('Get remaining tokens error:', err);
    return null;
  }
}

/**
 * Get user's usage statistics for current month
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Usage statistics
 */
export async function getUserUsageStats(userId) {
  try {
    const result = await db.query(
      `SELECT
        tus.*,
        st.name as tier_name,
        st.max_tokens_monthly
      FROM token_usage_summary tus
      JOIN users u ON tus.user_id = u.id
      JOIN subscription_tiers st ON u.current_tier = st.id
      WHERE tus.user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return {
        success: false,
        error: 'No usage data found'
      };
    }

    const stats = result.rows[0];
    const usagePercent = stats.monthly_limit
      ? Math.round((stats.current_month_tokens / stats.monthly_limit) * 100)
      : null;

    return {
      success: true,
      data: {
        ...stats,
        usage_percent: usagePercent,
        is_unlimited: stats.monthly_limit === null,
        remaining: stats.monthly_limit
          ? Math.max(0, stats.monthly_limit - stats.current_month_tokens)
          : null
      }
    };
  } catch (err) {
    console.error('Get usage stats error:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Check if user has access to a feature based on their tier
 * @param {string} userId - User ID
 * @param {string} featureName - Feature name to check
 * @returns {Promise<Object>} Feature access status
 */
export async function checkFeatureAccess(userId, featureName) {
  try {
    const result = await db.query(
      `SELECT
        st.features,
        st.name as tier_name
      FROM users u
      JOIN subscription_tiers st ON u.current_tier = st.id
      WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return {
        allowed: false,
        message: 'User not found'
      };
    }

    const tier = result.rows[0];
    const features = tier.features || {};
    const hasAccess = features[featureName] === true;

    return {
      allowed: hasAccess,
      tierName: tier.tierName,
      message: hasAccess
        ? `Feature available in ${tier.tier_name} plan`
        : `Feature not available in ${tier.tier_name} plan. Upgrade required.`
    };
  } catch (err) {
    console.error('Feature access check error:', err);
    // Fail open for non-critical features
    return {
      allowed: true,
      error: err.message
    };
  }
}

/**
 * Estimate token count from text (rough estimate)
 * @param {string} text - Text to estimate
 * @returns {number} Estimated token count
 */
export function estimateTokenCount(text) {
  if (!text) return 0;
  // Rough estimate: 1 token ≈ 4 characters for English text
  return Math.ceil(text.length / 4);
}

/**
 * Calculate cost from token count (in USD)
 * @param {number} tokens - Number of tokens
 * @param {number} [ratePerToken=0.00001] - Cost per token
 * @returns {number} Cost in USD
 */
export function calculateTokenCost(tokens, ratePerToken = 0.00001) {
  return parseFloat((tokens * ratePerToken).toFixed(6));
}

/**
 * Middleware to check token limits before operation
 * Usage: Add to API routes that consume tokens
 */
export async function enforceTokenLimit(userId) {
  const limitStatus = await checkTokenLimit(userId);

  if (limitStatus.limitExceeded) {
    return {
      allowed: false,
      error: limitStatus.message,
      status: 403
    };
  }

  return {
    allowed: true,
    remaining: limitStatus.remaining,
    currentTokens: limitStatus.currentTokens,
    monthlyLimit: limitStatus.monthlyLimit
  };
}

/**
 * Batch log multiple token usages (for performance)
 * @param {string} userId - User ID
 * @param {Array<Object>} usages - Array of usage objects
 * @returns {Promise<Object>} Batch insert result
 */
export async function batchLogTokenUsage(userId, usages) {
  if (!usages || usages.length === 0) {
    return { success: true, count: 0 };
  }

  try {
    const values = [];
    const params = [];
    let paramIndex = 1;

    for (const usage of usages) {
      const {
        operationType,
        resourceId = null,
        inputTokens,
        outputTokens,
        success = true,
        errorMessage = null,
        metadata = {}
      } = usage;

      const totalTokens = inputTokens + outputTokens;
      const costUsd = (totalTokens * 0.00001).toFixed(6);

      values.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8})`
      );

      params.push(
        userId,
        operationType,
        resourceId,
        inputTokens,
        outputTokens,
        costUsd,
        success,
        errorMessage,
        metadata
      );

      paramIndex += 9;
    }

    const query = `
      INSERT INTO token_usage (
        user_id, operation_type, resource_id, input_tokens,
        output_tokens, cost_usd, success, error_message, metadata
      ) VALUES ${values.join(', ')}
      RETURNING id
    `;

    const result = await db.query(query, params);

    return {
      success: true,
      count: result.rows.length
    };
  } catch (err) {
    console.error('Batch token usage logging error:', err);
    return {
      success: false,
      error: err.message
    };
  }
}
