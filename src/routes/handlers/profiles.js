/**
 * User Profiles API
 * Manages user profiles and preferences
 */

import { db } from '../../utils/database.js';
import { getUserId } from '../../middleware/auth/index.js';
import { success, error, handleCors } from '../../utils/responses.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const { method, url } = req;
  const pathParts = url.split('/').filter(Boolean);

  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    // GET /api/contexts/profiles - Get user profile
    if (method === 'GET' && pathParts.length === 3) {
      try {
        const profileResult = await db.query(
          'SELECT * FROM user_profiles WHERE user_id = $1',
          [userId]
        );

        const preferencesResult = await db.query(
          'SELECT category, key, value FROM user_preferences WHERE user_id = $1',
          [userId]
        );

        // Group preferences by category
        const preferences = {};
        for (const pref of preferencesResult.rows) {
          if (!preferences[pref.category]) {
            preferences[pref.category] = {};
          }
          preferences[pref.category][pref.key] = pref.value;
        }

        return res.json(success({
          profile: profileResult.rows[0] || null,
          preferences
        }));
      } catch (dbError) {
        // Tables might not exist yet - return empty profile
        console.log('Profiles tables not found, returning empty profile');
        return res.json(success({
          profile: null,
          preferences: {}
        }));
      }
    }

    // PUT /api/contexts/profiles - Update profile
    if (method === 'PUT' && pathParts.length === 3) {
      const {
        display_name,
        role,
        years_experience,
        primary_tech_stack,
        industries,
        location,
        timezone,
        preferred_tone,
        detail_level,
        code_style_preference,
        explanation_style,
        ai_instructions
      } = req.body;

      // Check if profile exists
      const existingResult = await db.query(
        'SELECT id FROM user_profiles WHERE user_id = $1',
        [userId]
      );

      let result;

      if (existingResult.rows.length === 0) {
        // Create new profile
        result = await db.query(
          `INSERT INTO user_profiles (
            user_id, display_name, role, years_experience, primary_tech_stack,
            industries, location, timezone, preferred_tone, detail_level,
            code_style_preference, explanation_style, ai_instructions
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING *`,
          [
            userId, display_name, role, years_experience, primary_tech_stack,
            industries, location, timezone, preferred_tone, detail_level,
            code_style_preference, explanation_style, ai_instructions
          ]
        );
      } else {
        // Update existing profile
        const updates = [];
        const params = [userId];
        let paramCount = 1;

        const fields = {
          display_name,
          role,
          years_experience,
          primary_tech_stack,
          industries,
          location,
          timezone,
          preferred_tone,
          detail_level,
          code_style_preference,
          explanation_style,
          ai_instructions
        };

        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined) {
            paramCount++;
            updates.push(`${key} = $${paramCount}`);
            params.push(value);
          }
        }

        if (updates.length === 0) {
          return res.status(400).json(error('No fields to update'));
        }

        updates.push('updated_at = NOW()');

        result = await db.query(
          `UPDATE user_profiles
           SET ${updates.join(', ')}
           WHERE user_id = $1
           RETURNING *`,
          params
        );
      }

      return res.json(success({ profile: result.rows[0] }));
    }

    // PUT /api/contexts/profiles/preferences - Update preference
    if (method === 'PUT' && pathParts.length === 4 && pathParts[3] === 'preferences') {
      const { category, key, value } = req.body;

      if (!category || !key || value === undefined) {
        return res.status(400).json(error('Category, key, and value are required'));
      }

      const result = await db.query(
        `INSERT INTO user_preferences (user_id, category, key, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, category, key)
         DO UPDATE SET value = $4, updated_at = NOW()
         RETURNING *`,
        [userId, category, key, value]
      );

      return res.json(success({ preference: result.rows[0] }));
    }

    // GET /api/contexts/profiles/ai-instructions - Get formatted AI instructions
    if (method === 'GET' && pathParts.length === 4 && pathParts[3] === 'ai-instructions') {
      const result = await db.query(
        'SELECT display_name, role, primary_tech_stack, preferred_tone, detail_level, ai_instructions FROM user_profiles WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return res.json(success({ instructions: '', formatted: '' }));
      }

      const profile = result.rows[0];

      // Format for LLM
      const formatted = [
        '# User Context',
        '',
        profile.display_name && `User: ${profile.display_name}`,
        profile.role && `Role: ${profile.role}`,
        profile.primary_tech_stack && profile.primary_tech_stack.length > 0 && `Tech Stack: ${profile.primary_tech_stack.join(', ')}`,
        '',
        '## Communication Preferences',
        profile.preferred_tone && `Tone: ${profile.preferred_tone}`,
        profile.detail_level && `Detail Level: ${profile.detail_level}`,
        '',
        profile.ai_instructions && '## Instructions',
        profile.ai_instructions
      ].filter(Boolean).join('\n');

      return res.json(success({
        instructions: profile.ai_instructions || '',
        formatted
      }));
    }

    return res.status(404).json(error('Not found', 404));

  } catch (err) {
    console.error('Profiles API Error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
