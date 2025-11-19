/**
 * Logout All Endpoint
 * Revokes all refresh tokens for the authenticated user
 * Requires valid access token
 */

import { db, logEvent, ensureTenant } from '../../../utils/database.js';
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
      `UPDATE session
       SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL
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

    const tenantId = await ensureTenant(userId);
    await logEvent({
      tenantId,
      eventType: 'user.logout',
      aggregateType: 'user',
      aggregateId: userId,
      actorId: userId,
      payload: {
        status: 'success',
        all_devices: true,
        revoked_count: revokedCount,
        ip_address: ipAddress,
        user_agent: userAgent
      }
    });

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
