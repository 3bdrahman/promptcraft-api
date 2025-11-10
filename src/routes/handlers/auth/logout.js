/**
 * Logout Endpoint
 * Revokes refresh token and logs logout event
 */

import { db } from '../../../utils/database.js';
import { success, error as createError } from '../../../utils/responses.js';
import { hashToken, getUserIdFromToken } from '../../../middleware/auth/jwt.js';
import { getIpAddress, getUserAgent } from '../../../middleware/auth/index.js';

export default async function handler(req, res) {
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

  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json(createError('Refresh token is required', 400));
    }

    const userId = getUserIdFromToken(refresh_token);

    console.log(`👋 Logout request for user: ${userId}`);

    // ============================================================
    // REVOKE REFRESH TOKEN
    // ============================================================

    const tokenHash = hashToken(refresh_token);

    const result = await db.query(
      `UPDATE refresh_tokens
       SET revoked = TRUE, revoked_at = NOW()
       WHERE token_hash = $1 AND revoked = FALSE
       RETURNING id, user_id`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      // Token not found or already revoked
      console.log('⚠️ Refresh token not found or already revoked');

      // Still return success (idempotent operation)
      return res.status(200).json(success({
        message: 'Logged out successfully'
      }));
    }

    const token = result.rows[0];

    // ============================================================
    // AUDIT LOG
    // ============================================================

    const ipAddress = getIpAddress(req);
    const userAgent = getUserAgent(req);

    await db.query(
      `INSERT INTO audit_logs (user_id, action, status, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [token.user_id, 'logout', 'success', ipAddress, userAgent]
    );

    console.log(`✅ User logged out: ${token.user_id}`);

    // ============================================================
    // RESPONSE
    // ============================================================

    return res.status(200).json(success({
      message: 'Logged out successfully'
    }));

  } catch (error) {
    console.error('❌ Logout error:', error);
    return res.status(500).json(createError(`Logout failed: ${error.message}`, 500));
  }
}
