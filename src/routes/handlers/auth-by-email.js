/**
 * Email-based Authentication API Endpoint
 * Registers new users or logs in existing users based on Chrome account email
 */

import { db } from '../../utils/database.js';
import { success, error as createError } from '../../utils/responses.js';

export default async function handler(req, res) {
  // CORS headers for Chrome extension
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
    const { email, username, source = 'chrome-extension', auto_register = true } = req.body;

    // Validate email
    if (!email || !isValidEmail(email)) {
      return res.status(400).json(createError('Valid email address is required', 400));
    }

    // For new registrations, username is required
    if (auto_register && username && !isValidUsername(username)) {
      return res.status(400).json(createError('Username must be 3-50 characters and contain only letters, numbers, and underscores', 400));
    }

    console.log(`📧 Email auth request for: ${email} from: ${source}`);

    let user;
    let isNewUser = false;

    // Use a transaction to handle race conditions
    const client = await db.getClient?.() || db;
    
    try {
      if (client.query !== db.query) {
        await client.query('BEGIN');
      }

      // Check if user already exists (with FOR UPDATE to prevent race conditions)
      const existingUser = await (client.query || db.query).call(client, 
        'SELECT id, email, username, created_at FROM users WHERE email = $1',
        [email]
      );

      if (existingUser.rows.length > 0) {
        // User exists - login scenario
        user = existingUser.rows[0];
        console.log(`✅ Existing user found: ${email} with username: ${user.username}`);
        
      } else if (auto_register) {
        // Create new user account
        if (!username) {
          throw new Error('Username is required for new registrations');
        }

        console.log(`👤 Attempting to create new user: ${email} with username: ${username}`);
        
        try {
          // Use INSERT with ON CONFLICT to handle race conditions
          const result = await (client.query || db.query).call(client,
            `INSERT INTO users (email, username) 
             VALUES ($1, $2) 
             ON CONFLICT (email) DO UPDATE SET 
               email = EXCLUDED.email
             RETURNING id, email, username, created_at, 
               (xmax = 0) AS is_new`,
            [email, username]
          );

          if (result.rows.length > 0) {
            user = result.rows[0];
            isNewUser = user.is_new;
            delete user.is_new; // Remove the helper field
            
            if (isNewUser) {
              console.log(`✅ New user created: ${email} with ID: ${user.id}`);
            } else {
              console.log(`✅ Existing user found via conflict resolution: ${email}`);
            }
          } else {
            throw new Error('Failed to create or retrieve user');
          }
        } catch (insertError) {
          // If username conflict, try with a different username
          if (insertError.message.includes('users_username_key')) {
            console.log(`⚠️ Username ${username} taken, trying to find existing user by email`);
            
            // Try to find user by email again (might have been created by another request)
            const retryUser = await (client.query || db.query).call(client,
              'SELECT id, email, username, created_at FROM users WHERE email = $1',
              [email]
            );
            
            if (retryUser.rows.length > 0) {
              user = retryUser.rows[0];
              console.log(`✅ Found existing user after username conflict: ${email}`);
            } else {
              throw new Error(`Username ${username} is already taken. Please try a different username.`);
            }
          } else {
            throw insertError;
          }
        }
        
      } else {
        throw new Error('User not found and auto-registration is disabled');
      }

      if (client.query !== db.query) {
        await client.query('COMMIT');
      }

    } catch (transactionError) {
      if (client.query !== db.query) {
        await client.query('ROLLBACK');
      }
      throw transactionError;
    } finally {
      if (client.release) {
        client.release();
      }
    }

    // Generate session token (simple approach - could be JWT in production)
    const sessionToken = generateSessionToken(user.id, email);

    // Return success
    return res.status(200).json(success({
      message: isNewUser ? 'User registered and authenticated' : 'User authenticated',
      user: {
        id: user.id,
        email: user.email,
        name: user.username,
        username: user.username,
        created_at: user.created_at
      },
      session_token: sessionToken,
      is_new_user: isNewUser,
      expires_in: 30 * 24 * 60 * 60 // 30 days
    }));

  } catch (error) {
    console.error('❌ Email auth error:', error);
    return res.status(500).json(createError(`Authentication failed: ${error.message}`, 500));
  }
}

/**
 * Validate email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate username format
 */
function isValidUsername(username) {
  const usernameRegex = /^[a-zA-Z0-9_]{3,50}$/;
  return usernameRegex.test(username);
}

/**
 * Generate simple session token
 * Note: In production, use JWT or proper session management
 */
function generateSessionToken(userId, email) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  const payload = `${userId}:${email}:${timestamp}:${random}`;
  
  // Simple base64 encoding (use proper encryption in production)
  return `chrome_${Buffer.from(payload).toString('base64')}`;
}