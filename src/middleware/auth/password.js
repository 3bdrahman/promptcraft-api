/**
 * Password Utilities
 * Enterprise-grade password hashing and validation
 */

import bcrypt from 'bcryptjs';

const SALT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');

/**
 * Hash a password using bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} - Hashed password
 */
export async function hashPassword(password) {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 * @param {string} password - Plain text password
 * @param {string} hash - Bcrypt hash
 * @returns {Promise<boolean>} - True if password matches
 */
export async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
export function validatePassword(password) {
  const errors = [];

  if (!password || typeof password !== 'string') {
    return { valid: false, errors: ['Password is required'] };
  }

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }

  if (password.length > 128) {
    errors.push('Password must not exceed 128 characters');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  // Check for common weak passwords
  const weakPasswords = [
    'password', 'password123', '12345678', 'qwerty123',
    'abc12345', 'password1', 'welcome123', 'admin123'
  ];

  if (weakPasswords.includes(password.toLowerCase())) {
    errors.push('This password is too common. Please choose a stronger password');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate email format
 * @param {string} email - Email address
 * @returns {boolean} - True if valid email format
 */
export function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }

  // RFC 5322 compliant email regex (simplified)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(email)) {
    return false;
  }

  // Additional checks
  if (email.length > 254) {
    return false;
  }

  const [localPart, domain] = email.split('@');

  if (localPart.length > 64 || domain.length > 253) {
    return false;
  }

  return true;
}

/**
 * Validate username format
 * @param {string} username - Username
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
export function validateUsername(username) {
  const errors = [];

  if (!username || typeof username !== 'string') {
    return { valid: false, errors: ['Username is required'] };
  }

  if (username.length < 3) {
    errors.push('Username must be at least 3 characters long');
  }

  if (username.length > 50) {
    errors.push('Username must not exceed 50 characters');
  }

  // Allow alphanumeric, underscores, and hyphens
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    errors.push('Username can only contain letters, numbers, underscores, and hyphens');
  }

  // Must start with a letter or number
  if (!/^[a-zA-Z0-9]/.test(username)) {
    errors.push('Username must start with a letter or number');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Generate a random token for email verification or password reset
 * @param {number} length - Token length (default: 32)
 * @returns {string} - Random token
 */
export function generateToken(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';

  for (let i = 0; i < length; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return token;
}

/**
 * Generate a cryptographically secure random token
 * @returns {string} - UUID v4 token
 */
export function generateSecureToken() {
  return crypto.randomUUID();
}
