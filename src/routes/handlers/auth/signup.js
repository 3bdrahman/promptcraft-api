/**
 * Signup Endpoint - Enterprise Grade
 * Creates new user accounts with proper security
 */

import { db, logEvent, ensureTenant } from '../../../utils/database.js';
import { success, error as createError } from '../../../utils/responses.js';
import { hashPassword, validatePassword, validateEmail, validateUsername } from '../../../middleware/auth/password.js';
import { generatePin, sendVerificationPin } from '../../../utils/email.js';

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

    const { email, username, password, source = 'web-app' } = bodyData;

    // ============================================================
    // VALIDATION
    // ============================================================

    // Validate email
    if (!email || !validateEmail(email)) {
      return res.status(400).json(createError('Valid email address is required', 400));
    }

    // Validate username
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return res.status(400).json(createError(usernameValidation.errors.join(', '), 400));
    }

    // Validate password
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json(createError(passwordValidation.errors.join(', '), 400));
    }

    console.log(`📧 Signup request for: ${email} (${username}) from: ${source}`);

    // ============================================================
    // CHECK EXISTING USER
    // ============================================================

    const existingUser = await db.query(
      'SELECT id, email, username FROM "user" WHERE email = $1 OR username = $2',
      [email.toLowerCase(), username]
    );

    if (existingUser.rows.length > 0) {
      const existing = existingUser.rows[0];

      if (existing.email.toLowerCase() === email.toLowerCase()) {
        return res.status(409).json(createError('Email already registered', 409));
      }

      if (existing.username === username) {
        return res.status(409).json(createError('Username already taken', 409));
      }
    }

    // ============================================================
    // CREATE USER
    // ============================================================

    // Hash password
    const passwordHash = await hashPassword(password);

    // Insert user
    const result = await db.query(
      `INSERT INTO "user" (
        email,
        username,
        password_hash,
        email_verified,
        created_at
      ) VALUES ($1, $2, $3, $4, NOW())
      RETURNING id, email, username, email_verified, created_at`,
      [email.toLowerCase(), username, passwordHash, false]
    );

    const user = result.rows[0];

    console.log(`✅ User created: ${email} with ID: ${user.id}`);

    // ============================================================
    // EMAIL VERIFICATION - 6-Digit PIN
    // ============================================================

    // Generate 6-digit PIN
    const pin = generatePin();
    const expiryMinutes = 15;
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000); // 15 minutes

    // Store PIN in database
    await db.query(
      `INSERT INTO email_verification_pins (user_id, pin, email, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, pin, email.toLowerCase(), expiresAt]
    );

    // Send verification PIN via email
    try {
      await sendVerificationPin(email, pin, expiryMinutes);
      console.log(`✅ Verification PIN sent to: ${email}`);
    } catch (emailError) {
      console.error(`❌ Failed to send verification email:`, emailError);
      // Continue anyway - PIN is in database, user can request resend
    }

    // ============================================================
    // AUDIT LOG
    // ============================================================

    const tenantId = await ensureTenant(user.id);
    await logEvent({
      tenantId,
      eventType: 'user.signup',
      aggregateType: 'user',
      aggregateId: user.id,
      actorId: user.id,
      payload: {
        status: 'success',
        source,
        email_verified: false,
        ip_address: req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
        user_agent: req.headers['user-agent']
      }
    });

    // ============================================================
    // RESPONSE
    // ============================================================

    return res.status(201).json(success({
      message: 'Account created successfully. Please check your email for a 6-digit verification code.',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        email_verified: user.email_verified,
        created_at: user.created_at
      },
      // For development, include PIN (remove this in production!)
      ...(process.env.NODE_ENV === 'development' && {
        dev_pin: pin
      })
    }));

  } catch (error) {
    console.error('❌ Signup error:', error);

    // Handle unique constraint violations
    if (error.code === '23505') {  // PostgreSQL unique violation
      if (error.constraint?.includes('email')) {
        return res.status(409).json(createError('Email already registered', 409));
      }
      if (error.constraint?.includes('username')) {
        return res.status(409).json(createError('Username already taken', 409));
      }
    }

    return res.status(500).json(createError(`Signup failed: ${error.message}`, 500));
  }
}
