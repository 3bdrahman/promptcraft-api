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

  // Parse URL and query parameters properly
  // In Express with router.use('/contexts/layers', handler):
  // - app.use('/api', router) strips /api
  // - router.use('/contexts/layers', handler) strips /contexts/layers
  // So the handler sees only the remaining path (e.g., "/" or "/:id")
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

    // GET / - List layers with filters (router.use strips /contexts/layers prefix)
    if (method === 'GET' && pathParts.length === 0) {
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

    // GET /search - Search layers with query
    if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'search') {
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

    // GET /:id - Get single layer
    if (method === 'GET' && pathParts.length === 1 && pathParts[0] !== 'search') {
      const layerId = pathParts[0];

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

    // POST / - Create layer
    if (method === 'POST' && pathParts.length === 0) {
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

    // PUT /:id - Update layer
    if (method === 'PUT' && pathParts.length === 1) {
      const layerId = pathParts[0];
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

    // DELETE /:id - Soft delete layer
    if (method === 'DELETE' && pathParts.length === 1) {
      const layerId = pathParts[0];

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

    // POST /:id/use - Track usage
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'use') {
      const layerId = pathParts[0];

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

    // POST /:id/rating - Rate layer
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'rating') {
      const layerId = pathParts[0];
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

    // GET /team/:teamId - Get team layers
    if (method === 'GET' && pathParts.length === 2 && pathParts[0] === 'team') {
      const teamId = pathParts[1];

      // Check if user has access to this team
      const accessCheck = await db.query(
        'SELECT user_has_team_access($1, $2) as has_access',
        [userId, teamId]
      );

      if (!accessCheck.rows[0].has_access) {
        return res.status(403).json(error('You do not have access to this team', 403));
      }

      // Get layers shared with this team
      const result = await db.query(
        `SELECT * FROM context_layers
         WHERE team_id = $1 AND visibility = 'team' AND deleted_at IS NULL
         ORDER BY updated_at DESC`,
        [teamId]
      );

      return res.json(success(result.rows));
    }

    // POST /:id/share - Share layer with team
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'share') {
      const layerId = pathParts[0];
      const { team_id } = req.body;

      if (!team_id) {
        return res.status(400).json(error('team_id is required', 400));
      }

      try {
        // Use the database function to share
        const result = await db.query(
          'SELECT share_layer_with_team($1, $2, $3) as success',
          [layerId, team_id, userId]
        );

        if (result.rows[0].success) {
          // Get updated layer
          const layerResult = await db.query(
            'SELECT * FROM context_layers WHERE id = $1',
            [layerId]
          );

          return res.json(success({
            layer: layerResult.rows[0],
            message: 'Layer shared with team successfully'
          }));
        }
      } catch (err) {
        return res.status(500).json(error(err.message || 'Failed to share layer', 500));
      }
    }

    // POST /:id/unshare - Unshare layer (make private)
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'unshare') {
      const layerId = pathParts[0];

      try {
        // Use the database function to unshare
        const result = await db.query(
          'SELECT unshare_layer($1, $2) as success',
          [layerId, userId]
        );

        if (result.rows[0].success) {
          // Get updated layer
          const layerResult = await db.query(
            'SELECT * FROM context_layers WHERE id = $1',
            [layerId]
          );

          return res.json(success({
            layer: layerResult.rows[0],
            message: 'Layer is now private'
          }));
        }
      } catch (err) {
        return res.status(500).json(error(err.message || 'Failed to unshare layer', 500));
      }
    }

    // GET /:id/versions - Get layer version history
    if (method === 'GET' && pathParts.length === 2 && pathParts[1] === 'versions') {
      const layerId = pathParts[0];

      try {
        const result = await db.query(
          'SELECT * FROM get_layer_version_history($1, $2)',
          [layerId, 50] // Get last 50 versions
        );

        return res.json(success({
          layer_id: layerId,
          versions: result.rows,
          total: result.rows.length
        }));
      } catch (err) {
        console.error('Error fetching layer versions:', err);
        return res.status(500).json(error('Failed to fetch version history', 500));
      }
    }

    // GET /:id/versions/:versionId - Get specific layer version
    if (method === 'GET' && pathParts.length === 3 && pathParts[1] === 'versions') {
      const layerId = pathParts[0];
      const versionId = pathParts[2];

      try {
        const result = await db.query(
          'SELECT * FROM context_layer_versions WHERE id = $1 AND layer_id = $2',
          [versionId, layerId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json(error('Version not found', 404));
        }

        return res.json(success({ version: result.rows[0] }));
      } catch (err) {
        console.error('Error fetching layer version:', err);
        return res.status(500).json(error('Failed to fetch version', 500));
      }
    }

    // POST /:id/revert/:versionId - Revert layer to specific version
    if (method === 'POST' && pathParts.length === 3 && pathParts[1] === 'revert') {
      const layerId = pathParts[0];
      const versionId = pathParts[2];

      try {
        const result = await db.query(
          'SELECT revert_layer_to_version($1, $2, $3) as success',
          [layerId, versionId, userId]
        );

        if (result.rows[0].success) {
          return res.json(success({
            message: 'Layer reverted successfully',
            layer_id: layerId
          }));
        }
      } catch (err) {
        console.error('Error reverting layer:', err);
        return res.status(500).json(error(err.message || 'Failed to revert layer', 500));
      }
    }

    // POST /:id/versions - Create manual version snapshot
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'versions') {
      const layerId = pathParts[0];
      const { change_summary } = req.body;

      try {
        const versionId = await db.query(
          'SELECT create_layer_version($1, $2, $3) as version_id',
          [layerId, userId, change_summary || 'Manual snapshot']
        );

        return res.json(success({
          message: 'Version created successfully',
          version_id: versionId.rows[0].version_id
        }));
      } catch (err) {
        console.error('Error creating layer version:', err);
        return res.status(500).json(error('Failed to create version', 500));
      }
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
