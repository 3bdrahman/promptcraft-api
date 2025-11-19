/**
 * Verify PIN Endpoint - DEPRECATED
 * Email verification is now tracked via user.email_verified column only
 * No PIN verification required
 */

import { success, error as createError } from '../../../utils/responses.js';

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

  // PIN verification is no longer required
  // Users are automatically verified or verification is handled differently
  return res.status(410).json(
    createError('Email verification via PIN is no longer supported. Users can login directly after signup.', 410)
  );
}
