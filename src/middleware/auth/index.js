/**
 * Auth Helpers
 * Convenience functions for authentication in route handlers
 */

import { authenticateToken, optionalAuth } from './middleware.js';
import { error as createError } from '../../utils/responses.js';

/**
 * Get user ID from request (if authenticated)
 * Returns null if user is not authenticated
 *
 * @param {Object} req - Request object
 * @returns {Promise<string|null>} - User ID or null
 */
export async function getUserId(req) {
  // If user is already attached to request (e.g., from middleware), return it
  if (req.user && req.user.id) {
    return req.user.id;
  }

  // Otherwise try to extract from Authorization header
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return null;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return null;
    }

    const token = parts[1];
    const { verifyAccessToken } = await import('./jwt.js');
    const payload = verifyAccessToken(token);

    if (!payload) {
      return null;
    }

    return payload.sub; // User ID is stored in 'sub' claim
  } catch (error) {
    console.error('getUserId error:', error);
    return null;
  }
}

/**
 * Require authentication for a route
 * Returns user object or sends 401 response
 *
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @returns {Promise<Object|null>} - User object or null (if response sent)
 */
export async function requireAuth(req, res) {
  try {
    // If user is already attached to request, return it
    if (req.user && req.user.id) {
      return req.user;
    }

    // Extract token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json(createError('Authorization header required', 401));
      return null;
    }

    const parts = authHeader.split(' ');

    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      res.status(401).json(createError('Invalid authorization format. Expected: Bearer <token>', 401));
      return null;
    }

    const token = parts[1];
    const { verifyAccessToken } = await import('./jwt.js');
    const payload = verifyAccessToken(token);

    if (!payload) {
      res.status(401).json(createError('Invalid or expired token', 401));
      return null;
    }

    // Return user object
    const user = {
      id: payload.sub,
      email: payload.email,
      username: payload.username,
      tokenId: payload.jti
    };

    // Attach to request for future use
    req.user = user;

    return user;
  } catch (error) {
    console.error('requireAuth error:', error);
    res.status(500).json(createError('Authentication failed', 500));
    return null;
  }
}

// Export middleware functions as well for convenience
export {
  authenticateToken,
  optionalAuth,
  requireVerifiedEmail,
  rateLimit,
  getIpAddress,
  getUserAgent
} from './middleware.js';
