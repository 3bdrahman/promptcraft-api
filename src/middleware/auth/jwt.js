/**
 * JWT Utilities
 * Token generation, verification, and management
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// Lazy load secrets - don't validate at import time (breaks serverless)
function getSecrets() {
  const JWT_SECRET = process.env.JWT_SECRET;
  const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

  if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set in environment variables. Add them to Vercel dashboard.');
  }

  return { JWT_SECRET, JWT_REFRESH_SECRET };
}

const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || '30m';
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || '30d';

/**
 * Generate a unique JWT ID
 * @returns {string} - Unique identifier
 */
function generateJti() {
  return crypto.randomUUID();
}

/**
 * Generate access token (short-lived)
 * @param {Object} user - User object with id, email, username
 * @returns {string} - JWT access token
 */
export function generateAccessToken(user) {
  const { JWT_SECRET } = getSecrets();

  const payload = {
    sub: user.id,
    email: user.email,
    username: user.username,
    type: 'access',
    jti: generateJti()
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
    issuer: 'promptcraft-api',
    audience: 'promptcraft-clients'
  });
}

/**
 * Generate refresh token (long-lived)
 * @param {Object} user - User object with id
 * @param {string} deviceInfo - Device identifier
 * @returns {string} - JWT refresh token
 */
export function generateRefreshToken(user, deviceInfo = 'unknown') {
  const { JWT_REFRESH_SECRET } = getSecrets();

  const payload = {
    sub: user.id,
    type: 'refresh',
    jti: generateJti(),
    device: deviceInfo
  };

  return jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
    issuer: 'promptcraft-api',
    audience: 'promptcraft-clients'
  });
}

/**
 * Verify access token
 * @param {string} token - JWT access token
 * @returns {Object|null} - Decoded payload or null if invalid
 */
export function verifyAccessToken(token) {
  try {
    const { JWT_SECRET } = getSecrets();

    const payload = jwt.verify(token, JWT_SECRET, {
      issuer: 'promptcraft-api',
      audience: 'promptcraft-clients'
    });

    if (payload.type !== 'access') {
      return null;
    }

    return payload;
  } catch (error) {
    console.error('Access token verification failed:', error.message);
    return null;
  }
}

/**
 * Verify refresh token
 * @param {string} token - JWT refresh token
 * @returns {Object|null} - Decoded payload or null if invalid
 */
export function verifyRefreshToken(token) {
  try {
    const { JWT_REFRESH_SECRET } = getSecrets();

    const payload = jwt.verify(token, JWT_REFRESH_SECRET, {
      issuer: 'promptcraft-api',
      audience: 'promptcraft-clients'
    });

    if (payload.type !== 'refresh') {
      return null;
    }

    return payload;
  } catch (error) {
    console.error('Refresh token verification failed:', error.message);
    return null;
  }
}

/**
 * Decode token without verification (use for inspection only)
 * @param {string} token - JWT token
 * @returns {Object|null} - Decoded payload or null if invalid
 */
export function decodeToken(token) {
  try {
    return jwt.decode(token);
  } catch (error) {
    return null;
  }
}

/**
 * Hash token for storage (SHA-256)
 * Used for storing refresh tokens securely
 * @param {string} token - Token to hash
 * @returns {string} - Hex string of hash
 */
export function hashToken(token) {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');
}

/**
 * Get token expiration date
 * @param {string} token - JWT token
 * @returns {Date|null} - Expiration date or null
 */
export function getTokenExpiration(token) {
  const decoded = decodeToken(token);

  if (!decoded || !decoded.exp) {
    return null;
  }

  return new Date(decoded.exp * 1000);
}

/**
 * Check if token is expired
 * @param {string} token - JWT token
 * @returns {boolean} - True if expired
 */
export function isTokenExpired(token) {
  const expiration = getTokenExpiration(token);

  if (!expiration) {
    return true;
  }

  return expiration < new Date();
}

/**
 * Generate token pair (access + refresh)
 * @param {Object} user - User object
 * @param {string} deviceInfo - Device identifier
 * @returns {Object} - { accessToken, refreshToken, expiresIn }
 */
export function generateTokenPair(user, deviceInfo = 'unknown') {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user, deviceInfo);

  // Calculate expiration in seconds
  const decoded = decodeToken(accessToken);
  const expiresIn = decoded ? decoded.exp - Math.floor(Date.now() / 1000) : 1800;

  return {
    accessToken,
    refreshToken,
    expiresIn,
    tokenType: 'Bearer'
  };
}

/**
 * Extract user ID from token
 * @param {string} token - JWT token
 * @returns {string|null} - User ID or null
 */
export function getUserIdFromToken(token) {
  const decoded = decodeToken(token);
  return decoded?.sub || null;
}
