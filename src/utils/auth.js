import { db } from './database.js';
import { verifyAccessToken } from '../middleware/auth/jwt.js';

// User validation supporting JWT, Chrome extension session tokens, and legacy OAuth
export const getUserFromToken = async (authHeader) => {
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);

  // PRIORITY 1: Handle JWT tokens from enterprise auth (most common now)
  try {
    const payload = verifyAccessToken(token);
    if (payload) {
      // JWT verified successfully - payload contains { sub, email, username, type, jti }
      return {
        id: payload.sub,
        email: payload.email,
        name: payload.username,
        username: payload.username,
        verified: true,
        source: 'jwt-auth'
      };
    }
  } catch (error) {
    // Not a valid JWT, try other token types
    console.log('Not a JWT token, trying other auth methods...');
  }

  // PRIORITY 2: Handle Chrome extension session tokens (format: chrome_<base64>)
  if (token.startsWith('chrome_')) {
    try {
      const payload = Buffer.from(token.substring(7), 'base64').toString('utf8');
      const [userId, email, timestamp, random] = payload.split(':');
      
      // Basic token validation (check if not too old - 30 days)
      const tokenAge = Date.now() - parseInt(timestamp);
      const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
      
      if (tokenAge > maxAge) {
        console.warn('Session token expired');
        return null;
      }
      
      // Return user info (could query database for full user info if needed)
      return {
        id: userId,
        email: email,
        name: email.split('@')[0], // Default name from email
        verified: true,
        source: 'chrome-extension'
      };
      
    } catch (error) {
      console.error('Chrome session token validation failed:', error);
      return null;
    }
  }
  
  // Legacy: Handle Google OAuth tokens
  try {
    const response = await fetch(
      `https://www.googleapis.com/oauth2/v1/userinfo?access_token=${token}`
    );
    
    if (!response.ok) {
      return null;
    }
    
    const userInfo = await response.json();
    
    return {
      id: userInfo.id,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      verified: true,
      source: 'google-oauth'
    };
  } catch (error) {
    console.error('Google OAuth token validation failed:', error);
    return null;
  }
};

// Get user ID from request (for database operations)
export const getUserId = async (req) => {
  const tokenUser = await getUserFromToken(req.headers.authorization);
  if (!tokenUser) return null;

  // If we already have the user ID from JWT, return it directly
  if (tokenUser.id) {
    return tokenUser.id;
  }

  // Otherwise, look up user ID from database using email (legacy auth methods)
  try {
    const userResult = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [tokenUser.email]
    );

    return userResult.rows[0]?.id || null;
  } catch (error) {
    console.error('Database user ID lookup failed:', error);
    return null;
  }
};

// Require authentication middleware with full user data from database
export const requireAuth = async (req, res) => {
  const tokenUser = await getUserFromToken(req.headers.authorization);
  if (!tokenUser) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  
  // Fetch full user record from database using email
  try {
    const userResult = await db.query(
      'SELECT id, email, username, email_verified, created_at FROM users WHERE email = $1',
      [tokenUser.email]
    );
    
    if (userResult.rows.length === 0) {
      res.status(401).json({ error: 'User not found in database' });
      return null;
    }
    
    // Return combined user data (token info + database info)
    return {
      ...tokenUser,
      ...userResult.rows[0]
    };
  } catch (error) {
    console.error('Database user lookup failed:', error);
    res.status(500).json({ error: `Authentication failed: ${error.message}` });
    return null;
  }
};