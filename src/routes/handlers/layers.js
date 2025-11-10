/**
 * Context Layers API
 * Unified API for all context layer types (profile, project, task, snippet, adhoc)
 * Replaces old context_snippets system
 */

import { db } from '../../utils/database.js';
import { getUserId } from '../../middleware/auth/index.js';
import { success, error, handleCors } from '../../utils/responses.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const { method, url } = req;

  // Parse URL and query parameters properly for Vercel
  const urlObj = new URL(url, `https://${req.headers.host || 'localhost'}`);
  const pathParts = urlObj.pathname.split('/').filter(Boolean);
  const query = Object.fromEntries(urlObj.searchParams);

  // Merge with req.query if it exists
  req.query = { ...query, ...req.query };

  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    // GET /api/contexts/layers - List layers with filters
    if (method === 'GET' && pathParts.length === 3) {
      const {
        type, // layer_type filter
        tags,
        visibility,
        is_template,
        search,
        sort = 'updated_at',
        order = 'DESC',
        limit = 50,
        offset = 0
      } = req.query;

      let query = `
        SELECT * FROM context_layers
        WHERE user_id = $1 AND deleted_at IS NULL
      `;
      const params = [userId];
      let paramCount = 1;

      // Apply filters
      if (type) {
        paramCount++;
        query += ` AND layer_type = $${paramCount}`;
        params.push(type);
      }

      if (tags) {
        paramCount++;
        query += ` AND tags && $${paramCount}`;
        params.push(tags.split(','));
      }

      if (visibility) {
        paramCount++;
        query += ` AND visibility = $${paramCount}`;
        params.push(visibility);
      }

      if (is_template !== undefined) {
        paramCount++;
        query += ` AND is_template = $${paramCount}`;
        params.push(is_template === 'true');
      }

      if (search) {
        paramCount++;
        query += ` AND (name ILIKE $${paramCount} OR description ILIKE $${paramCount} OR content ILIKE $${paramCount})`;
        params.push(`%${search}%`);
      }

      // Sorting
      const validSortFields = ['name', 'created_at', 'updated_at', 'usage_count', 'avg_rating'];
      const sortField = validSortFields.includes(sort) ? sort : 'updated_at';
      const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      query += ` ORDER BY ${sortField} ${sortOrder}`;

      // Pagination
      paramCount++;
      query += ` LIMIT $${paramCount}`;
      params.push(parseInt(limit));

      paramCount++;
      query += ` OFFSET $${paramCount}`;
      params.push(parseInt(offset));

      try {
        const result = await db.query(query, params);

        // Return just the array for frontend compatibility
        return res.json(success(result.rows));
      } catch (dbError) {
        // Table might not exist yet - return empty array
        console.log('Context layers table not found, returning empty array');
        return res.json(success([]));
      }
    }

    // GET /api/contexts/layers/search - Search layers with query
    if (method === 'GET' && pathParts.length === 4 && pathParts[3] === 'search') {
      const { q, limit = 10 } = req.query;

      if (!q || q.trim().length < 2) {
        return res.json(success({ layers: [] }));
      }

      const result = await db.query(
        `SELECT id, name, description, layer_type, tags, usage_count
         FROM context_layers
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND (name ILIKE $2 OR description ILIKE $2 OR content ILIKE $2)
         ORDER BY usage_count DESC, updated_at DESC
         LIMIT $3`,
        [userId, `%${q}%`, parseInt(limit)]
      );

      return res.json(success({ layers: result.rows }));
    }

    // GET /api/contexts/layers/:id - Get single layer
    if (method === 'GET' && pathParts.length === 4 && pathParts[3] !== 'search') {
      const layerId = pathParts[3];

      const result = await db.query(
        `SELECT * FROM context_layers
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [layerId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Layer not found', 404));
      }

      return res.json(success({ layer: result.rows[0] }));
    }

    // POST /api/contexts/layers - Create layer
    if (method === 'POST' && pathParts.length === 3) {
      const {
        name,
        description,
        content,
        layer_type,
        tags = [],
        metadata = {},
        visibility = 'private',
        is_template = false,
        device_last_modified
      } = req.body;

      // Validation
      if (!name || !content || !layer_type) {
        return res.status(400).json(error('Name, content, and layer_type are required'));
      }

      const validTypes = ['profile', 'project', 'task', 'snippet', 'adhoc'];
      if (!validTypes.includes(layer_type)) {
        return res.status(400).json(error(`Invalid layer_type. Must be one of: ${validTypes.join(', ')}`));
      }

      // Calculate token count (rough estimate: 1 token ≈ 4 characters)
      const token_count = Math.ceil(content.length / 4);

      // Check subscription limits
      const limitCheck = await checkLayerLimit(userId);
      if (!limitCheck.allowed) {
        return res.status(403).json(error(limitCheck.message, 403));
      }

      const result = await db.query(
        `INSERT INTO context_layers (
          user_id, name, description, content, layer_type, tags, metadata,
          token_count, visibility, is_template, device_last_modified, last_synced_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        RETURNING *`,
        [
          userId, name, description, content, layer_type, tags, metadata,
          token_count, visibility, is_template, device_last_modified
        ]
      );

      return res.status(201).json(success({ layer: result.rows[0] }));
    }

    // PUT /api/contexts/layers/:id - Update layer
    if (method === 'PUT' && pathParts.length === 4) {
      const layerId = pathParts[3];
      const {
        name,
        description,
        content,
        layer_type,
        tags,
        metadata,
        visibility,
        is_template,
        device_last_modified
      } = req.body;

      // Verify ownership
      const ownerCheck = await db.query(
        'SELECT id FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [layerId, userId]
      );

      if (ownerCheck.rows.length === 0) {
        return res.status(404).json(error('Layer not found', 404));
      }

      const updates = [];
      const params = [layerId, userId];
      let paramCount = 2;

      if (name !== undefined) {
        paramCount++;
        updates.push(`name = $${paramCount}`);
        params.push(name);
      }

      if (description !== undefined) {
        paramCount++;
        updates.push(`description = $${paramCount}`);
        params.push(description);
      }

      if (content !== undefined) {
        paramCount++;
        updates.push(`content = $${paramCount}`);
        params.push(content);

        // Recalculate token count
        paramCount++;
        updates.push(`token_count = $${paramCount}`);
        params.push(Math.ceil(content.length / 4));
      }

      if (layer_type !== undefined) {
        paramCount++;
        updates.push(`layer_type = $${paramCount}`);
        params.push(layer_type);
      }

      if (tags !== undefined) {
        paramCount++;
        updates.push(`tags = $${paramCount}`);
        params.push(tags);
      }

      if (metadata !== undefined) {
        paramCount++;
        updates.push(`metadata = $${paramCount}`);
        params.push(metadata);
      }

      if (visibility !== undefined) {
        paramCount++;
        updates.push(`visibility = $${paramCount}`);
        params.push(visibility);
      }

      if (is_template !== undefined) {
        paramCount++;
        updates.push(`is_template = $${paramCount}`);
        params.push(is_template);
      }

      if (device_last_modified !== undefined) {
        paramCount++;
        updates.push(`device_last_modified = $${paramCount}`);
        params.push(device_last_modified);
      }

      if (updates.length === 0) {
        return res.status(400).json(error('No fields to update'));
      }

      updates.push('last_synced_at = NOW()');

      const result = await db.query(
        `UPDATE context_layers
         SET ${updates.join(', ')}
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING *`,
        params
      );

      return res.json(success({ layer: result.rows[0] }));
    }

    // DELETE /api/contexts/layers/:id - Soft delete layer
    if (method === 'DELETE' && pathParts.length === 4) {
      const layerId = pathParts[3];

      const result = await db.query(
        `UPDATE context_layers
         SET deleted_at = NOW()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id, name`,
        [layerId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Layer not found', 404));
      }

      return res.json(success({
        id: result.rows[0].id,
        name: result.rows[0].name,
        deleted: true
      }));
    }

    // POST /api/contexts/layers/:id/use - Track usage
    if (method === 'POST' && pathParts.length === 5 && pathParts[4] === 'use') {
      const layerId = pathParts[3];

      const result = await db.query(
        `UPDATE context_layers
         SET usage_count = usage_count + 1,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id, usage_count`,
        [layerId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Layer not found', 404));
      }

      return res.json(success(result.rows[0]));
    }

    // POST /api/contexts/layers/:id/rating - Rate layer
    if (method === 'POST' && pathParts.length === 5 && pathParts[4] === 'rating') {
      const layerId = pathParts[3];
      const { rating } = req.body;

      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json(error('Rating must be between 1 and 5'));
      }

      // Get current rating info
      const current = await db.query(
        'SELECT avg_rating, favorite_count FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [layerId, userId]
      );

      if (current.rows.length === 0) {
        return res.status(404).json(error('Layer not found', 404));
      }

      // Calculate new average (simple moving average)
      const currentAvg = parseFloat(current.rows[0].avg_rating) || 0;
      const ratingCount = current.rows[0].favorite_count || 0;
      const newAvg = ((currentAvg * ratingCount) + rating) / (ratingCount + 1);

      const result = await db.query(
        `UPDATE context_layers
         SET avg_rating = $3,
             favorite_count = favorite_count + 1,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id, avg_rating, favorite_count`,
        [layerId, userId, newAvg]
      );

      return res.json(success(result.rows[0]));
    }

    return res.status(404).json(error('Not found', 404));

  } catch (err) {
    console.error('Context Layers API Error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * Check if user can create more layers based on subscription tier
 */
async function checkLayerLimit(userId) {
  try {
    // Get user's tier limits
    const tierResult = await db.query(
      `SELECT st.max_contexts
       FROM users u
       JOIN subscription_tiers st ON u.current_tier = st.id
       WHERE u.id = $1`,
      [userId]
    );

    if (tierResult.rows.length === 0) {
      return { allowed: false, message: 'User subscription not found' };
    }

    const maxContexts = tierResult.rows[0].max_contexts;

    // NULL means unlimited (enterprise tier)
    if (maxContexts === null) {
      return { allowed: true };
    }

    // Count current layers
    const countResult = await db.query(
      'SELECT COUNT(*) FROM context_layers WHERE user_id = $1 AND deleted_at IS NULL',
      [userId]
    );

    const currentCount = parseInt(countResult.rows[0].count);

    if (currentCount >= maxContexts) {
      return {
        allowed: false,
        message: `Context layer limit reached (${maxContexts}). Upgrade your plan for more.`
      };
    }

    return { allowed: true };
  } catch (err) {
    console.error('Layer limit check error:', err);
    return { allowed: true }; // Fail open to avoid blocking users
  }
}
