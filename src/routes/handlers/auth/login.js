/**
 * Login Endpoint - Enterprise Grade
 * Authenticates users and issues JWT tokens
 */

import { db, logEvent, ensureTenant } from '../../../utils/database.js';
import { success, error as createError } from '../../../utils/responses.js';
import { verifyPassword, validateEmail } from '../../../middleware/auth/password.js';
import { generateTokenPair, hashToken } from '../../../middleware/auth/jwt.js';
import { getIpAddress, getUserAgent } from '../../../middleware/auth/index.js';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

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

  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const { email, password, device_info = 'unknown', remember_me = false } = req.body;

    // ============================================================
    // VALIDATION
    // ============================================================

    if (!email || !validateEmail(email)) {
      await client.query('ROLLBACK');
      return res.status(400).json(createError('Valid email address is required', 400));
    }

    if (!password) {
      await client.query('ROLLBACK');
      return res.status(400).json(createError('Password is required', 400));
    }

    const ipAddress = getIpAddress(req);
    const userAgent = getUserAgent(req);

    console.log(`🔐 Login attempt for: ${email} from ${ipAddress}`);

    // ============================================================
    // FIND USER
    // ============================================================

    const userResult = await client.query(
      `SELECT id, email, username, password_hash, email_verified,
              failed_login_attempts, locked_until, last_login_at
       FROM "user"
       WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      // Note: Cannot log to event table without tenant_id (user doesn't exist)
      // Security events for non-existent users could be logged to a system-wide audit table in the future

      await client.query('COMMIT');

      // Don't reveal that user doesn't exist (security best practice)
      return res.status(401).json(createError('Invalid email or password', 401));
    }

    const user = userResult.rows[0];

    // ============================================================
    // CHECK IF ACCOUNT IS LOCKED
    // ============================================================

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesRemaining = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);

      // Log locked account attempt
      const tenantId = await ensureTenant(user.id, client);
      await logEvent({
        tenantId,
        eventType: 'user.login',
        aggregateType: 'user',
        aggregateId: user.id,
        actorId: user.id,
        payload: {
          status: 'blocked',
          reason: 'account_locked',
          minutes_remaining: minutesRemaining,
          ip_address: ipAddress,
          user_agent: userAgent
        },
        client
      });

      await client.query('COMMIT');

      return res.status(423).json(
        createError(
          `Account temporarily locked due to too many failed login attempts. Please try again in ${minutesRemaining} minutes.`,
          423
        )
      );
    }

    // ============================================================
    // VERIFY PASSWORD
    // ============================================================

    const isValidPassword = await verifyPassword(password, user.password_hash);

    if (!isValidPassword) {
      // Increment failed login attempts
      const newFailedAttempts = (user.failed_login_attempts || 0) + 1;
      let lockedUntil = null;

      // Lock account if too many attempts
      if (newFailedAttempts >= MAX_LOGIN_ATTEMPTS) {
        lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
        console.log(`🔒 Account locked for user ${email} until ${lockedUntil}`);
      }

      await client.query(
        `UPDATE "user"
         SET failed_login_attempts = $1,
             locked_until = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [newFailedAttempts, lockedUntil, user.id]
      );

      // Log failed login
      const tenantId = await ensureTenant(user.id, client);
      await logEvent({
        tenantId,
        eventType: 'user.login',
        aggregateType: 'user',
        aggregateId: user.id,
        actorId: user.id,
        payload: {
          status: 'failure',
          reason: 'invalid_password',
          failed_attempts: newFailedAttempts,
          locked: !!lockedUntil,
          ip_address: ipAddress,
          user_agent: userAgent
        },
        client
      });

      await client.query('COMMIT');

      const attemptsRemaining = MAX_LOGIN_ATTEMPTS - newFailedAttempts;

      if (lockedUntil) {
        return res.status(423).json(
          createError('Account locked due to too many failed login attempts. Please try again in 15 minutes.', 423)
        );
      }

      return res.status(401).json(
        createError(
          `Invalid email or password. ${attemptsRemaining} ${attemptsRemaining === 1 ? 'attempt' : 'attempts'} remaining.`,
          401
        )
      );
    }

    // ============================================================
    // CHECK EMAIL VERIFICATION (Optional - can be enforced or not)
    // ============================================================

    // For now, we'll allow unverified users to login but return a flag
    // You can enforce verification by uncommenting:
    //
    // if (!user.email_verified) {
    //   await client.query('COMMIT');
    //   return res.status(403).json(
    //     createError('Please verify your email before logging in', 403)
    //   );
    // }

    // ============================================================
    // GENERATE TOKENS
    // ============================================================

    const tokens = generateTokenPair(user, device_info);

    // ============================================================
    // STORE REFRESH TOKEN
    // ============================================================

    const accessTokenHash = hashToken(tokens.accessToken);
    const refreshTokenHash = hashToken(tokens.refreshToken);
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await client.query(
      `INSERT INTO session (user_id, access_token, refresh_token, device_info, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [user.id, accessTokenHash, refreshTokenHash, device_info, ipAddress, userAgent, refreshExpiresAt]
    );

    // ============================================================
    // RESET FAILED LOGIN ATTEMPTS
    // ============================================================

    await client.query(
      `UPDATE "user"
       SET failed_login_attempts = 0,
           locked_until = NULL,
           last_login_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    // ============================================================
    // AUDIT LOG
    // ============================================================

    const tenantId = await ensureTenant(user.id, client);
    await logEvent({
      tenantId,
      eventType: 'user.login',
      aggregateType: 'user',
      aggregateId: user.id,
      actorId: user.id,
      payload: {
        status: 'success',
        device_info,
        email_verified: user.email_verified,
        ip_address: ipAddress,
        user_agent: userAgent
      },
      client
    });

    await client.query('COMMIT');

    console.log(`✅ Login successful for: ${email}`);

    // ============================================================
    // RESPONSE
    // ============================================================

    return res.status(200).json(success({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        email_verified: user.email_verified
      },
      tokens: {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: tokens.expiresIn,
        token_type: tokens.tokenType
      },
      // Warn if email not verified
      ...(!user.email_verified && {
        warning: 'Please verify your email address'
      })
    }));

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Login error:', error);
    return res.status(500).json(createError(`Login failed: ${error.message}`, 500));
  } finally {
    client.release();
  }
}
