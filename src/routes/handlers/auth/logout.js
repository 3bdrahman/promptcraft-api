/**
 * Logout Endpoint
 * Revokes refresh token and logs logout event
 */

import { db, logEvent, ensureTenant } from '../../../utils/database.js';
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
      `UPDATE session
       SET revoked_at = NOW()
       WHERE refresh_token = $1 AND revoked_at IS NULL
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

    const tenantId = await ensureTenant(token.user_id);
    await logEvent({
      tenantId,
      eventType: 'user.logout',
      aggregateType: 'user',
      aggregateId: token.user_id,
      actorId: token.user_id,
      payload: {
        status: 'success',
        ip_address: ipAddress,
        user_agent: userAgent
      }
    });

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
