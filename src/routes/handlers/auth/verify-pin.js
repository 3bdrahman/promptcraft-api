/**
 * Verify PIN Endpoint
 * Verifies 6-digit email verification PIN and auto-logs in the user
 */

import { db } from '../../../utils/database.js';
import { success, error as createError } from '../../../utils/responses.js';
import { sendWelcomeEmail } from '../../../utils/email.js';
import { generateTokenPair, hashToken } from '../../../middleware/auth/jwt.js';
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
    // Handle body parsing - Vercel throws when accessing req.body with invalid JSON
    let bodyData;
    try {
      bodyData = req.body;
      if (typeof bodyData === 'string') {
        bodyData = JSON.parse(bodyData);
      }
    } catch (bodyError) {
      // req.body access threw - read from stream instead
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      bodyData = rawBody ? JSON.parse(rawBody) : {};
    }

    const { email, pin } = bodyData;

    // ============================================================
    // VALIDATION
    // ============================================================

    if (!email || !pin) {
      return res.status(400).json(createError('Email and PIN are required', 400));
    }

    // Validate PIN format (6 digits)
    if (!/^\d{6}$/.test(pin)) {
      return res.status(400).json(createError('PIN must be 6 digits', 400));
    }

    console.log(`🔐 PIN verification request for: ${email}`);

    // ============================================================
    // FIND PIN RECORD
    // ============================================================

    const pinResult = await db.query(
      `SELECT
        vp.id,
        vp.user_id,
        vp.pin,
        vp.attempts,
        vp.max_attempts,
        vp.expires_at,
        vp.verified,
        u.username,
        u.email_verified
       FROM email_verification_pins vp
       JOIN users u ON u.id = vp.user_id
       WHERE vp.email = $1
         AND vp.verified = FALSE
       ORDER BY vp.created_at DESC
       LIMIT 1`,
      [email.toLowerCase()]
    );

    if (pinResult.rows.length === 0) {
      return res.status(404).json(createError('No pending verification found for this email. Please request a new PIN.', 404));
    }

    const pinRecord = pinResult.rows[0];

    // ============================================================
    // CHECK EXPIRY
    // ============================================================

    if (new Date() > new Date(pinRecord.expires_at)) {
      return res.status(410).json(createError('PIN has expired. Please request a new one.', 410));
    }

    // ============================================================
    // CHECK MAX ATTEMPTS
    // ============================================================

    if (pinRecord.attempts >= pinRecord.max_attempts) {
      return res.status(429).json(createError('Maximum verification attempts exceeded. Please request a new PIN.', 429));
    }

    // ============================================================
    // VERIFY PIN
    // ============================================================

    if (pinRecord.pin !== pin) {
      // Increment failed attempts
      await db.query(
        `UPDATE email_verification_pins
         SET attempts = attempts + 1
         WHERE id = $1`,
        [pinRecord.id]
      );

      const remainingAttempts = pinRecord.max_attempts - pinRecord.attempts - 1;

      // Log failed attempt
      await db.query(
        `INSERT INTO audit_logs (user_id, action, status, ip_address, user_agent, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          pinRecord.user_id,
          'verify_pin',
          'failure',
          req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
          req.headers['user-agent'],
          JSON.stringify({
            reason: 'invalid_pin',
            attempts: pinRecord.attempts + 1,
            remaining: remainingAttempts
          })
        ]
      );

      return res.status(400).json(createError(
        `Invalid PIN. ${remainingAttempts} attempt${remainingAttempts !== 1 ? 's' : ''} remaining.`,
        400
      ));
    }

    // ============================================================
    // SUCCESS - Mark as Verified
    // ============================================================

    // Mark PIN as verified
    await db.query(
      `UPDATE email_verification_pins
       SET verified = TRUE, verified_at = NOW()
       WHERE id = $1`,
      [pinRecord.id]
    );

    // Mark user's email as verified and update last login
    await db.query(
      `UPDATE users
       SET email_verified = TRUE,
           email_verified_at = NOW(),
           last_login_at = NOW(),
           failed_login_attempts = 0,
           locked_until = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [pinRecord.user_id]
    );

    console.log(`✅ Email verified for user: ${pinRecord.user_id}`);

    // ============================================================
    // GENERATE TOKENS FOR AUTO-LOGIN
    // ============================================================

    const ipAddress = getIpAddress(req);
    const userAgent = getUserAgent(req);
    const deviceInfo = 'web-app';

    // Get full user object for token generation
    const userResult = await db.query(
      `SELECT id, email, username, email_verified, created_at
       FROM users WHERE id = $1`,
      [pinRecord.user_id]
    );

    const user = userResult.rows[0];

    // Generate JWT tokens
    const tokens = generateTokenPair(user, deviceInfo);

    // Store refresh token
    const tokenHash = hashToken(tokens.refreshToken);
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, tokenHash, deviceInfo, ipAddress, userAgent, refreshExpiresAt]
    );

    // ============================================================
    // SEND WELCOME EMAIL
    // ============================================================

    try {
      await sendWelcomeEmail(email, pinRecord.username);
    } catch (emailError) {
      console.error('❌ Failed to send welcome email:', emailError);
      // Don't fail the verification if welcome email fails
    }

    // ============================================================
    // AUDIT LOG
    // ============================================================

    await db.query(
      `INSERT INTO audit_logs (user_id, action, status, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        pinRecord.user_id,
        'verify_pin',
        'success',
        ipAddress,
        userAgent,
        JSON.stringify({ email_verified: true, auto_login: true })
      ]
    );

    // ============================================================
    // RESPONSE - Auto-login with tokens
    // ============================================================

    return res.status(200).json(success({
      message: 'Email verified successfully! You are now logged in.',
      verified: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        email_verified: true
      },
      tokens: {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: tokens.expiresIn,
        token_type: tokens.tokenType
      }
    }));

  } catch (error) {
    console.error('❌ PIN verification error:', error);
    return res.status(500).json(createError(`Verification failed: ${error.message}`, 500));
  }
}
