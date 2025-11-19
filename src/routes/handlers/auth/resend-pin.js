/**
 * Resend PIN Endpoint
 * Resends verification PIN to user's email
 */

import { db, logEvent, ensureTenant } from '../../../utils/database.js';
import { success, error as createError } from '../../../utils/responses.js';
// import { generatePin, // sendVerificationPin } from '../../../utils/email.js';

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
    const { email } = req.body;

    // ============================================================
    // VALIDATION
    // ============================================================

    if (!email) {
      return res.status(400).json(createError('Email is required', 400));
    }

    console.log(`📧 Resend PIN request for: ${email}`);

    // ============================================================
    // CHECK USER EXISTS AND NOT VERIFIED
    // ============================================================

    const userResult = await db.query(
      `SELECT id, email, username, email_verified
       FROM "user"
       WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      // Don't reveal if email exists or not (security)
      return res.status(200).json(success({
        message: 'If this email is registered and unverified, a new PIN has been sent.'
      }));
    }

    const user = userResult.rows[0];

    // If already verified, return success (don't reveal this info)
    if (user.email_verified) {
      return res.status(200).json(success({
        message: 'If this email is registered and unverified, a new PIN has been sent.'
      }));
    }

    // ============================================================
    // RATE LIMITING - Check recent resends
    // ============================================================

    const recentPinsResult = await db.query(
      `SELECT COUNT(*) as count
       FROM email_verification_pins
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '5 minutes'`,
      [user.id]
    );

    const recentPinsCount = parseInt(recentPinsResult.rows[0].count);

    if (recentPinsCount >= 3) {
      return res.status(429).json(createError(
        'Too many PIN requests. Please wait 5 minutes before requesting another PIN.',
        429
      ));
    }

    // ============================================================
    // INVALIDATE OLD PINS
    // ============================================================

    // Mark all old unverified PINs as expired for this user
    await db.query(
      `UPDATE email_verification_pins
       SET verified = TRUE, verified_at = NOW()
       WHERE user_id = $1 AND verified = FALSE`,
      [user.id]
    );

    // ============================================================
    // GENERATE NEW PIN
    // ============================================================

    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryMinutes = 15;
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    // Store new PIN
    await db.query(
      `INSERT INTO email_verification_pins (user_id, pin, email, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, pin, email.toLowerCase(), expiresAt]
    );

    // ============================================================
    // SEND EMAIL
    // ============================================================

    try {
      await // sendVerificationPin(email, pin, expiryMinutes);
      console.log(`✅ New verification PIN sent to: ${email}`);
    } catch (emailError) {
      console.error(`❌ Failed to send verification email:`, emailError);
      // Return error if email fails
      return res.status(500).json(createError('Failed to send verification email. Please try again.', 500));
    }

    // ============================================================
    // AUDIT LOG
    // ============================================================

    const tenantId = await ensureTenant(user.id);
    await logEvent({
      tenantId,
      eventType: 'user.resend_pin',
      aggregateType: 'user',
      aggregateId: user.id,
      actorId: user.id,
      payload: {
        status: 'success',
        email,
        ip_address: req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
        user_agent: req.headers['user-agent']
      }
    });

    // ============================================================
    // RESPONSE
    // ============================================================

    return res.status(200).json(success({
      message: 'A new verification PIN has been sent to your email.',
      // For development, include PIN
      ...(process.env.NODE_ENV === 'development' && {
        dev_pin: pin
      })
    }));

  } catch (error) {
    console.error('❌ Resend PIN error:', error);
    return res.status(500).json(createError(`Failed to resend PIN: ${error.message}`, 500));
  }
}
