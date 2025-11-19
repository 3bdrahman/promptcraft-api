/**
 * User Profile & Settings API
 * Unified endpoint for user profile management and application settings
 *
 * Endpoints:
 * - GET    /api/user/profile - Get user profile with settings
 * - PUT    /api/user/profile - Update user profile and settings
 * - DELETE /api/user - Delete user account
 */

import { db, logEvent, ensureTenant } from '../../utils/database.js';
import { getUserId, requireAuth } from '../../middleware/auth/index.js';
import { success, error, handleCors } from '../../utils/responses.js';

export default async function handler(req, res) {
  // Handle CORS preflight
  if (handleCors(req, res)) return;

  const { method, url } = req;
  const urlObj = new URL(url, `https://${req.headers.host || 'localhost'}`);
  const pathParts = urlObj.pathname.split('/').filter(Boolean);

  try {
    // All user endpoints require authentication
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Authentication required', 401));
    }

    // GET /user/profile - Get complete user profile with settings
    if (method === 'GET' && pathParts[0] === 'profile') {
      return await getUserProfile(req, res, userId);
    }

    // PUT /user/profile - Update profile and/or settings
    if (method === 'PUT' && pathParts[0] === 'profile') {
      return await updateUserProfile(req, res, userId);
    }

    // DELETE /user - Delete user account (danger zone)
    if (method === 'DELETE' && pathParts.length === 0) {
      return await deleteUserAccount(req, res, userId);
    }

    return res.status(404).json(error('Endpoint not found', 404));

  } catch (err) {
    console.error('❌ [User API Error]:', err);
    return res.status(500).json(error(`Internal server error: ${err.message}`, 500));
  }
}

/**
 * Get user profile with all settings
 */
async function getUserProfile(req, res, userId) {
  try {
    // Get user basic info
    const userResult = await db.query(
      `SELECT id, username, email, name, created_at, updated_at
       FROM "user" WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json(error('User not found', 404));
    }

    const user = userResult.rows[0];

    // Get settings (stored as JSONB in user table)
    const settingsResult = await db.query(
      'SELECT settings FROM "user" WHERE id = $1',
      [userId]
    );

    const settings = settingsResult.rows[0]?.settings || null;

    // Get legacy preferences for backward compatibility
    const preferencesResult = await db.query(
      `SELECT category, key, value
       FROM user_preferences
       WHERE user_id = $1`,
      [userId]
    ).catch(() => ({ rows: [] })); // Ignore if table doesn't exist

    // Group preferences by category
    const preferences = {};
    for (const pref of preferencesResult.rows) {
      if (!preferences[pref.category]) {
        preferences[pref.category] = {};
      }
      preferences[pref.category][pref.key] = pref.value;
    }

    return res.json(success({
      ...user,
      settings,
      preferences,
    }));

  } catch (err) {
    console.error('Error fetching user profile:', err);
    return res.status(500).json(error('Failed to fetch profile', 500));
  }
}

/**
 * Update user profile and settings
 */
async function updateUserProfile(req, res, userId) {
  try {
    const {
      name,
      email,
      settings,
      preferences,
      currentPassword,
      newPassword
    } = req.body;

    // Start transaction
    await db.query('BEGIN');

    const updates = [];
    const params = [userId];
    let paramCount = 1;

    // Update basic fields
    if (name !== undefined) {
      paramCount++;
      updates.push(`name = $${paramCount}`);
      params.push(name);
    }

    if (email !== undefined) {
      paramCount++;
      updates.push(`email = $${paramCount}`);
      params.push(email);
    }

    // Update settings (JSONB)
    if (settings !== undefined) {
      paramCount++;
      updates.push(`settings = $${paramCount}`);
      params.push(JSON.stringify(settings));
    }

    // Always update timestamp
    updates.push('updated_at = NOW()');

    // Execute update
    let userResult;
    if (updates.length > 1) { // More than just updated_at
      userResult = await db.query(
        `UPDATE "user"
         SET ${updates.join(', ')}
         WHERE id = $1
         RETURNING id, username, email, name, settings, created_at, updated_at`,
        params
      );
    } else {
      // Just fetch current user if no updates
      userResult = await db.query(
        `SELECT id, username, email, name, settings, created_at, updated_at
         FROM "user" WHERE id = $1`,
        [userId]
      );
    }

    // Handle password change if requested
    if (currentPassword && newPassword) {
      const bcrypt = await import('bcryptjs');

      // Verify current password
      const passwordResult = await db.query(
        'SELECT password_hash FROM "user" WHERE id = $1',
        [userId]
      );

      const isValid = await bcrypt.compare(
        currentPassword,
        passwordResult.rows[0].password_hash
      );

      if (!isValid) {
        await db.query('ROLLBACK');
        return res.status(400).json(error('Current password is incorrect', 400));
      }

      // Hash new password
      const newHash = await bcrypt.hash(newPassword, 12);

      // Update password
      await db.query(
        'UPDATE "user" SET password_hash = $1 WHERE id = $2',
        [newHash, userId]
      );
    }

    // Update legacy preferences if provided (backward compatibility)
    if (preferences) {
      for (const [category, prefs] of Object.entries(preferences)) {
        for (const [key, value] of Object.entries(prefs)) {
          await db.query(
            `INSERT INTO user_preferences (user_id, category, key, value)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, category, key)
             DO UPDATE SET value = $4, updated_at = NOW()`,
            [userId, category, key, value]
          ).catch(() => {}); // Ignore if table doesn't exist
        }
      }
    }

    await db.query('COMMIT');

    const updatedUser = userResult.rows[0];

    // Log the profile update event
    try {
      const tenantId = await ensureTenant(userId);
      await logEvent(tenantId, 'user.profile_updated', {
        userId,
        changes: {
          name: name !== undefined ? name : undefined,
          email: email !== undefined ? email : undefined,
          settings: settings !== undefined ? true : undefined,
          password: currentPassword && newPassword ? true : undefined
        }
      });
    } catch (logErr) {
      console.error('Failed to log profile update event:', logErr);
      // Continue with response even if logging fails
    }

    return res.json(success({
      ...updatedUser,
      message: 'Profile updated successfully'
    }));

  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Error updating user profile:', err);
    return res.status(500).json(error('Failed to update profile', 500));
  }
}

/**
 * Delete user account (soft delete)
 */
async function deleteUserAccount(req, res, userId) {
  try {
    // Soft delete - mark as deleted but keep data
    await db.query(
      `UPDATE "user"
       SET deleted_at = NOW(),
           email = CONCAT(email, '.deleted.', id),
           updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );

    // Log the account deletion event
    try {
      const tenantId = await ensureTenant(userId);
      await logEvent(tenantId, 'user.deleted', {
        userId,
        timestamp: new Date().toISOString()
      });
    } catch (logErr) {
      console.error('Failed to log user deletion event:', logErr);
      // Continue with response even if logging fails
    }

    return res.json(success({
      deleted: true,
      message: 'Account deleted successfully'
    }));

  } catch (err) {
    console.error('Error deleting user account:', err);
    return res.status(500).json(error('Failed to delete account', 500));
  }
}
