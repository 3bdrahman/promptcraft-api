/**
 * Authentication Middleware
 * Protects routes and validates JWT tokens
 */

import { verifyAccessToken } from './jwt.js';
import { error as createError } from '../../utils/responses.js';

/**
 * Authenticate request using JWT access token
 * Expects: Authorization: Bearer <token>
 *
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware
 */
export async function authenticateToken(req, res, next) {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json(createError('Authorization header required', 401));
    }

    const parts = authHeader.split(' ');

    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json(createError('Invalid authorization format. Expected: Bearer <token>', 401));
    }

    const token = parts[1];

    // Verify token
    const payload = verifyAccessToken(token);

    if (!payload) {
      return res.status(401).json(createError('Invalid or expired token', 401));
    }

    // Attach user info to request
    req.user = {
      id: payload.sub,
      email: payload.email,
      username: payload.username,
      tokenId: payload.jti
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json(createError('Authentication failed', 500));
  }
}

/**
 * Optional authentication - don't fail if token is missing
 * But validate if present
 *
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware
 */
export async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      req.user = null;
      return next();
    }

    const parts = authHeader.split(' ');

    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      req.user = null;
      return next();
    }

    const token = parts[1];
    const payload = verifyAccessToken(token);

    if (payload) {
      req.user = {
        id: payload.sub,
        email: payload.email,
        username: payload.username,
        tokenId: payload.jti
      };
    } else {
      req.user = null;
    }

    next();
  } catch (error) {
    console.error('Optional auth error:', error);
    req.user = null;
    next();
  }
}

/**
 * Check if user is verified (email verification)
 *
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware
 */
export async function requireVerifiedEmail(req, res, next) {
  if (!req.user) {
    return res.status(401).json(createError('Authentication required', 401));
  }

  // Query database to check if email is verified
  // This is a placeholder - you'll need to implement the actual check
  // For now, we'll allow all authenticated users

  next();
}

/**
 * Rate limiting middleware (simple in-memory implementation)
 * For production, use Redis
 */
const rateLimitStore = new Map();

/**
 * Create rate limiter
 *
 * @param {number} maxRequests - Max requests allowed
 * @param {number} windowMs - Time window in milliseconds
 * @param {string} identifier - What to limit by ('ip', 'user', 'email')
 * @returns {Function} - Middleware function
 */
export function rateLimit(maxRequests, windowMs, identifier = 'ip') {
  return (req, res, next) => {
    try {
      let key;

      switch (identifier) {
        case 'ip':
          key = req.ip || req.connection.remoteAddress;
          break;
        case 'user':
          key = req.user?.id || req.ip;
          break;
        case 'email':
          key = req.body?.email || req.ip;
          break;
        default:
          key = req.ip;
      }

      const now = Date.now();
      const keyWithWindow = `${key}:${Math.floor(now / windowMs)}`;

      if (!rateLimitStore.has(keyWithWindow)) {
        rateLimitStore.set(keyWithWindow, { count: 0, resetAt: now + windowMs });
      }

      const record = rateLimitStore.get(keyWithWindow);

      if (record.count >= maxRequests) {
        const retryAfter = Math.ceil((record.resetAt - now) / 1000);

        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetAt / 1000));
        res.setHeader('Retry-After', retryAfter);

        return res.status(429).json(
          createError(`Too many requests. Please try again in ${retryAfter} seconds`, 429)
        );
      }

      record.count++;

      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', maxRequests - record.count);
      res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetAt / 1000));

      // Clean up old entries (every 100 requests)
      if (Math.random() < 0.01) {
        for (const [k, v] of rateLimitStore.entries()) {
          if (v.resetAt < now) {
            rateLimitStore.delete(k);
          }
        }
      }

      next();
    } catch (error) {
      console.error('Rate limit error:', error);
      next(); // Don't block on error
    }
  };
}

/**
 * Extract IP address from request
 *
 * @param {Object} req - Request object
 * @returns {string} - IP address
 */
export function getIpAddress(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/**
 * Extract user agent from request
 *
 * @param {Object} req - Request object
 * @returns {string} - User agent
 */
export function getUserAgent(req) {
  return req.headers['user-agent'] || 'unknown';
}
