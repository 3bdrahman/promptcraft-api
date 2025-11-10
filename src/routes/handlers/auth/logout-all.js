/**
 * Logout All Endpoint
 * Revokes all refresh tokens for the authenticated user
 * Requires valid access token
 */

import { db } from '../../../utils/database.js';
import { success, error as createError } from '../../../utils/responses.js';
import { authenticateToken, getIpAddress, getUserAgent } from '../../../middleware/auth/index.js';

async function handler(req, res) {
  // Must be authenticated
  if (!req.user) {
    return res.status(401).json(createError('Authentication required', 401));
  }

  try {
    const userId = req.user.id;

    console.log(`👋 Logout all devices request for user: ${userId}`);

    // ============================================================
    // REVOKE ALL REFRESH TOKENS
    // ============================================================

    const result = await db.query(
      `UPDATE refresh_tokens
       SET revoked = TRUE, revoked_at = NOW()
       WHERE user_id = $1 AND revoked = FALSE
       RETURNING id`,
      [userId]
    );

    const revokedCount = result.rows.length;

    console.log(`✅ Revoked ${revokedCount} tokens for user: ${userId}`);

    // ============================================================
    // AUDIT LOG
    // ============================================================

    const ipAddress = getIpAddress(req);
    const userAgent = getUserAgent(req);

    await db.query(
      `INSERT INTO audit_logs (user_id, action, status, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, 'logout_all', 'success', ipAddress, userAgent,
       JSON.stringify({ revoked_count: revokedCount })]
    );

    // ============================================================
    // RESPONSE
    // ============================================================

    return res.status(200).json(success({
      message: 'Logged out from all devices successfully',
      revoked_count: revokedCount
    }));

  } catch (error) {
    console.error('❌ Logout all error:', error);
    return res.status(500).json(createError(`Logout failed: ${error.message}`, 500));
  }
}

// Export with middleware
export default async function(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json(createError('Method not allowed', 405));
  }

  // Apply authentication middleware
  return authenticateToken(req, res, () => handler(req, res));
}
