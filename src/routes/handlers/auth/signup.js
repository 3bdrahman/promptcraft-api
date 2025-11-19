/**
 * Signup Endpoint - Enterprise Grade
 * Creates new user accounts with proper security
 */

import { db, logEvent } from '../../../utils/database.js';
import { success, error as createError } from '../../../utils/responses.js';
import { hashPassword, validatePassword, validateEmail, validateUsername } from '../../../middleware/auth/password.js';

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

    // Check for existing email (emails must be unique globally)
    const existingEmail = await db.query(
      'SELECT id FROM "user" WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingEmail.rows.length > 0) {
      return res.status(409).json(createError('Email already registered', 409));
    }

    // Check for existing username (usernames are globally unique for simplicity)
    const existingUsername = await db.query(
      'SELECT id FROM "user" WHERE username = $1',
      [username]
    );

    if (existingUsername.rows.length > 0) {
      return res.status(409).json(createError('Username already taken', 409));
    }

    // ============================================================
    // CREATE TENANT & USER
    // ============================================================

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create tenant first
    const tenantResult = await db.query(
      `INSERT INTO tenant (name, slug, settings)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`${username}'s Workspace`, `user-${username}-${Date.now()}`, {}]
    );

    const tenantId = tenantResult.rows[0].id;

    // Insert user with tenant_id
    const result = await db.query(
      `INSERT INTO "user" (
        tenant_id,
        email,
        username,
        password_hash,
        email_verified,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id, email, username, email_verified, created_at`,
      [tenantId, email.toLowerCase(), username, passwordHash, false]
    );

    const user = result.rows[0];

    console.log(`✅ User created: ${email} with ID: ${user.id}, tenant: ${tenantId}`);

    // Note: Email verification is tracked via user.email_verified column
    // Users start with email_verified = false
    // They can verify later via a verification link or be auto-verified

    // ============================================================
    // AUDIT LOG
    // ============================================================

    // Log signup event (tenant already created above)
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
      message: 'Account created successfully. You can now log in.',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        email_verified: user.email_verified,
        created_at: user.created_at
      }
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
