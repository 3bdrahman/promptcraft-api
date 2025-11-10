/**
 * Subscription Management API
 * Handles subscription tiers, upgrades, and billing
 */

import { db } from '../../utils/database.js';
import { getUserId } from '../../middleware/auth/index.js';
import { success, error, handleCors } from '../../utils/responses.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const { method, url } = req;
  const pathParts = url.split('/').filter(Boolean);

  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    // GET /api/user/subscription - Get user's current subscription
    if (method === 'GET' && pathParts.length === 3) {
      const result = await db.query(
        `SELECT
          u.id as user_id,
          u.username,
          u.email,
          u.current_tier,
          u.subscription_status,
          s.id as subscription_id,
          s.billing_cycle,
          s.current_period_start,
          s.current_period_end,
          s.cancel_at_period_end,
          st.name as tier_name,
          st.price_monthly,
          st.price_yearly,
          st.max_templates,
          st.max_contexts,
          st.max_tokens_monthly,
          st.max_api_calls_per_day,
          st.features,
          tus.current_month_tokens,
          tus.current_month_cost,
          tus.monthly_limit
        FROM users u
        LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
        LEFT JOIN subscription_tiers st ON u.current_tier = st.id
        LEFT JOIN token_usage_summary tus ON u.id = tus.user_id
        WHERE u.id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('User not found', 404));
      }

      const subscription = result.rows[0];

      // Calculate usage percentages
      const tokenUsagePercent = subscription.monthly_limit
        ? Math.round((subscription.current_month_tokens / subscription.monthly_limit) * 100)
        : null; // null means unlimited

      return res.json(success({
        subscription: {
          ...subscription,
          token_usage_percent: tokenUsagePercent,
          is_unlimited: subscription.monthly_limit === null
        }
      }));
    }

    // GET /api/user/subscription/tiers - Get available subscription tiers
    if (method === 'GET' && pathParts.length === 4 && pathParts[3] === 'tiers') {
      const result = await db.query(
        `SELECT * FROM subscription_tiers
         WHERE is_active = true
         ORDER BY price_monthly ASC`
      );

      return res.json(success({ tiers: result.rows }));
    }

    // GET /api/user/subscription/usage - Get detailed usage statistics
    if (method === 'GET' && pathParts.length === 4 && pathParts[3] === 'usage') {
      const { month } = req.query;
      const targetMonth = month ? new Date(month) : new Date();
      const monthStart = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), 1);
      const monthEnd = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0);

      // Get token usage breakdown
      const usageResult = await db.query(
        `SELECT
          operation_type,
          COUNT(*) as operation_count,
          SUM(input_tokens) as total_input_tokens,
          SUM(output_tokens) as total_output_tokens,
          SUM(total_tokens) as total_tokens,
          SUM(cost_usd) as total_cost,
          SUM(CASE WHEN success THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) as failure_count
        FROM token_usage
        WHERE user_id = $1
          AND created_at >= $2
          AND created_at <= $3
        GROUP BY operation_type
        ORDER BY total_tokens DESC`,
        [userId, monthStart, monthEnd]
      );

      // Get summary
      const summaryResult = await db.query(
        'SELECT * FROM token_usage_summary WHERE user_id = $1',
        [userId]
      );

      // Get layer and template counts
      const countsResult = await db.query(
        `SELECT
          (SELECT COUNT(*) FROM context_layers WHERE user_id = $1 AND deleted_at IS NULL) as layer_count,
          (SELECT COUNT(*) FROM templates WHERE user_id = $1 AND deleted_at IS NULL) as template_count,
          (SELECT COUNT(*) FROM context_combinations WHERE user_id = $1 AND deleted_at IS NULL) as combination_count`,
        [userId]
      );

      return res.json(success({
        month: monthStart.toISOString().substring(0, 7),
        usage_breakdown: usageResult.rows,
        summary: summaryResult.rows[0] || null,
        counts: countsResult.rows[0] || { layer_count: 0, template_count: 0, combination_count: 0 }
      }));
    }

    // POST /api/user/subscription/upgrade - Upgrade subscription
    if (method === 'POST' && pathParts.length === 4 && pathParts[3] === 'upgrade') {
      const { tier_id, billing_cycle = 'monthly', payment_method } = req.body;

      if (!tier_id) {
        return res.status(400).json(error('tier_id is required'));
      }

      // Verify tier exists
      const tierResult = await db.query(
        'SELECT * FROM subscription_tiers WHERE id = $1 AND is_active = true',
        [tier_id]
      );

      if (tierResult.rows.length === 0) {
        return res.status(404).json(error('Subscription tier not found', 404));
      }

      const tier = tierResult.rows[0];

      // Don't allow downgrading to free
      if (tier_id === 'free') {
        return res.status(400).json(error('Cannot upgrade to free tier'));
      }

      // Calculate period
      const now = new Date();
      const periodEnd = new Date(now);
      if (billing_cycle === 'yearly') {
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      } else {
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      }

      // Calculate amount
      const amount = billing_cycle === 'yearly' ? tier.price_yearly : tier.price_monthly;

      // Start transaction
      const client = await db.connect();
      try {
        await client.query('BEGIN');

        // Cancel existing subscription
        await client.query(
          `UPDATE subscriptions
           SET status = 'cancelled',
               cancelled_at = NOW()
           WHERE user_id = $1 AND status = 'active'`,
          [userId]
        );

        // Create new subscription
        const subResult = await client.query(
          `INSERT INTO subscriptions (
            user_id, tier_id, status, billing_cycle,
            current_period_start, current_period_end
          ) VALUES ($1, $2, 'active', $3, $4, $5)
          RETURNING *`,
          [userId, tier_id, billing_cycle, now, periodEnd]
        );

        const subscription = subResult.rows[0];

        // Update user's tier
        await client.query(
          'UPDATE users SET current_tier = $1, subscription_status = $2 WHERE id = $3',
          [tier_id, 'active', userId]
        );

        // Update token usage summary with new limits
        await client.query(
          `INSERT INTO token_usage_summary (user_id, monthly_limit)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET
             monthly_limit = $2,
             last_updated = NOW()`,
          [userId, tier.max_tokens_monthly]
        );

        // Create payment transaction (pending until processed)
        const txResult = await client.query(
          `INSERT INTO payment_transactions (
            user_id, subscription_id, amount, payment_method, status
          ) VALUES ($1, $2, $3, $4, 'pending')
          RETURNING *`,
          [userId, subscription.id, amount, payment_method]
        );

        await client.query('COMMIT');

        return res.json(success({
          subscription: subscription,
          transaction: txResult.rows[0],
          message: `Successfully upgraded to ${tier.name}`
        }));
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // POST /api/user/subscription/cancel - Cancel subscription
    if (method === 'POST' && pathParts.length === 4 && pathParts[3] === 'cancel') {
      const { immediately = false } = req.body;

      const result = await db.query(
        `UPDATE subscriptions
         SET cancel_at_period_end = true,
             ${immediately ? "status = 'cancelled', " : ''}
             cancelled_at = NOW()
         WHERE user_id = $1 AND status = 'active'
         RETURNING *`,
        [userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('No active subscription found', 404));
      }

      // If immediate cancellation, downgrade to free tier
      if (immediately) {
        await db.query(
          'UPDATE users SET current_tier = $1, subscription_status = $2 WHERE id = $3',
          ['free', 'cancelled', userId]
        );

        // Update token limits
        await db.query(
          `UPDATE token_usage_summary
           SET monthly_limit = 50000
           WHERE user_id = $1`,
          [userId]
        );
      }

      return res.json(success({
        subscription: result.rows[0],
        message: immediately
          ? 'Subscription cancelled immediately'
          : 'Subscription will cancel at end of billing period'
      }));
    }

    // GET /api/user/subscription/history - Get payment history
    if (method === 'GET' && pathParts.length === 4 && pathParts[3] === 'history') {
      const { limit = 20, offset = 0 } = req.query;

      const result = await db.query(
        `SELECT * FROM payment_transactions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, parseInt(limit), parseInt(offset)]
      );

      const countResult = await db.query(
        'SELECT COUNT(*) FROM payment_transactions WHERE user_id = $1',
        [userId]
      );

      return res.json(success({
        transactions: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }));
    }

    return res.status(404).json(error('Not found', 404));

  } catch (err) {
    console.error('Subscription API Error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
