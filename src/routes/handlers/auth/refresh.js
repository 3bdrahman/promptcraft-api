/**
 * Refresh Token Endpoint
 * Issues new access token using refresh token
 */

import { db, logEvent, ensureTenant } from '../../../utils/database.js';
import { success, error as createError } from '../../../utils/responses.js';
import { verifyRefreshToken, generateAccessToken, generateRefreshToken, hashToken, getUserIdFromToken } from '../../../middleware/auth/jwt.js';
import { getIpAddress, getUserAgent } from '../../../middleware/auth/index.js';

// Set to true to rotate refresh tokens (more secure, but requires client to update)
const ROTATE_REFRESH_TOKENS = true;

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

    console.log(`🔄 Refresh token request`);

    // ============================================================
    // VERIFY JWT SIGNATURE & EXPIRATION
    // ============================================================

    const payload = verifyRefreshToken(refresh_token);

    if (!payload) {
      return res.status(401).json(createError('Invalid or expired refresh token', 401));
    }

    const userId = payload.sub;
    const deviceInfo = payload.device || 'unknown';

    // ============================================================
    // CHECK TOKEN IN DATABASE
    // ============================================================

    const tokenHash = hashToken(refresh_token);

    const tokenResult = await db.query(
      `SELECT id, user_id, revoked_at, expires_at
       FROM session
       WHERE refresh_token = $1`,
      [tokenHash]
    );

    if (tokenResult.rows.length === 0) {
      console.log('⚠️ Refresh token not found in database (possible token reuse attack)');

      // Note: Cannot log without tenant for non-existent token
      // In production, consider logging to a system-wide security audit table

      return res.status(401).json(createError('Invalid refresh token', 401));
    }

    const tokenRecord = tokenResult.rows[0];

    // Check if token is revoked
    if (tokenRecord.revoked_at) {
      console.log('⚠️ Attempted use of revoked refresh token');

      const tenantId = await ensureTenant(userId);
      await logEvent({
        tenantId,
        eventType: 'user.token_refresh',
        aggregateType: 'user',
        aggregateId: userId,
        actorId: userId,
        payload: {
          status: 'blocked',
          reason: 'token_revoked'
        }
      });

      return res.status(401).json(createError('Refresh token has been revoked', 401));
    }

    // Check if token is expired (redundant with JWT check, but good practice)
    if (new Date(tokenRecord.expires_at) < new Date()) {
      console.log('⚠️ Refresh token expired');
      return res.status(401).json(createError('Refresh token expired', 401));
    }

    // ============================================================
    // GET USER DATA
    // ============================================================

    const userResult = await db.query(
      `SELECT id, email, username, email_verified
       FROM "user"
       WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      console.log('⚠️ User not found for refresh token');
      return res.status(401).json(createError('User not found', 401));
    }

    const user = userResult.rows[0];

    // ============================================================
    // GENERATE NEW ACCESS TOKEN
    // ============================================================

    const newAccessToken = generateAccessToken(user);

    let response = {
      access_token: newAccessToken,
      expires_in: 1800,  // 30 minutes
      token_type: 'Bearer'
    };

    // ============================================================
    // ROTATE REFRESH TOKEN (OPTIONAL)
    // ============================================================

    if (ROTATE_REFRESH_TOKENS) {
      const newRefreshToken = generateRefreshToken(user, deviceInfo);
      const newTokenHash = hashToken(newRefreshToken);
      const ipAddress = getIpAddress(req);
      const userAgent = getUserAgent(req);

      // Revoke old refresh token
      await db.query(
        `UPDATE session
         SET revoked_at = NOW()
         WHERE id = $1`,
        [tokenRecord.id]
      );

      // Store new refresh token
      const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      await db.query(
        `INSERT INTO session (user_id, refresh_token, device_info, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, newTokenHash, deviceInfo, ipAddress, userAgent, refreshExpiresAt]
      );

      response.refresh_token = newRefreshToken;

      console.log(`✅ Tokens rotated for user: ${user.email}`);
    } else {
      console.log(`✅ New access token issued for user: ${user.email}`);
    }

    // ============================================================
    // AUDIT LOG
    // ============================================================

    const tenantId = await ensureTenant(user.id);
    await logEvent({
      tenantId,
      eventType: 'user.token_refresh',
      aggregateType: 'user',
      aggregateId: user.id,
      actorId: user.id,
      payload: {
        status: 'success',
        device_info: deviceInfo,
        rotated: ROTATE_REFRESH_TOKENS
      }
    });

    // ============================================================
    // RESPONSE
    // ============================================================

    return res.status(200).json(success({
      tokens: response
    }));

  } catch (error) {
    console.error('❌ Refresh token error:', error);
    return res.status(500).json(createError(`Token refresh failed: ${error.message}`, 500));
  }
}
