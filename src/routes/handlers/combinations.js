/**
 * Context Combinations API
 * Manages saved combinations of context layers
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

    // GET /api/contexts/combinations - List combinations
    if (method === 'GET' && pathParts.length === 3) {
      const {
        tags,
        is_favorite,
        search,
        limit = 50,
        offset = 0
      } = req.query;

      let query = `
        SELECT * FROM context_combinations
        WHERE user_id = $1 AND deleted_at IS NULL
      `;
      const params = [userId];
      let paramCount = 1;

      // Apply filters
      if (tags) {
        paramCount++;
        query += ` AND tags && $${paramCount}`;
        params.push(tags.split(','));
      }

      if (is_favorite === 'true') {
        query += ` AND is_favorite = true`;
      }

      if (search) {
        paramCount++;
        query += ` AND (name ILIKE $${paramCount} OR description ILIKE $${paramCount})`;
        params.push(`%${search}%`);
      }

      // Order by favorites first, then usage
      query += ` ORDER BY is_favorite DESC, usage_count DESC, updated_at DESC`;

      // Pagination
      paramCount++;
      query += ` LIMIT $${paramCount}`;
      params.push(parseInt(limit));

      paramCount++;
      query += ` OFFSET $${paramCount}`;
      params.push(parseInt(offset));

      const result = await db.query(query, params);

      // Get total count
      let countQuery = 'SELECT COUNT(*) FROM context_combinations WHERE user_id = $1 AND deleted_at IS NULL';
      const countResult = await db.query(countQuery, [userId]);

      return res.json(success({
        combinations: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }));
    }

    // GET /api/contexts/combinations/:id - Get single combination with full layer details
    if (method === 'GET' && pathParts.length === 4) {
      const combinationId = pathParts[3];

      // Get combination
      const comboResult = await db.query(
        `SELECT * FROM context_combinations
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [combinationId, userId]
      );

      if (comboResult.rows.length === 0) {
        return res.status(404).json(error('Combination not found', 404));
      }

      const combination = comboResult.rows[0];

      // Get full layer details
      if (combination.layer_ids && combination.layer_ids.length > 0) {
        const layersResult = await db.query(
          `SELECT id, name, description, layer_type, content, tags, token_count
           FROM context_layers
           WHERE id = ANY($1) AND deleted_at IS NULL
           ORDER BY array_position($1, id)`,
          [combination.layer_ids]
        );

        combination.layers = layersResult.rows;
      } else {
        combination.layers = [];
      }

      return res.json(success({ combination }));
    }

    // POST /api/contexts/combinations - Create combination
    if (method === 'POST' && pathParts.length === 3) {
      const {
        name,
        description,
        layer_ids,
        tags = [],
        is_favorite = false
      } = req.body;

      // Validation
      if (!name || !layer_ids || !Array.isArray(layer_ids) || layer_ids.length === 0) {
        return res.status(400).json(error('Name and layer_ids (non-empty array) are required'));
      }

      // Verify all layers belong to user
      const layerCheck = await db.query(
        `SELECT id FROM context_layers
         WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL`,
        [layer_ids, userId]
      );

      if (layerCheck.rows.length !== layer_ids.length) {
        return res.status(400).json(error('Some layer IDs are invalid or do not belong to you'));
      }

      const result = await db.query(
        `INSERT INTO context_combinations (
          user_id, name, description, layer_ids, tags, is_favorite
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [userId, name, description, layer_ids, tags, is_favorite]
      );

      return res.status(201).json(success({ combination: result.rows[0] }));
    }

    // PUT /api/contexts/combinations/:id - Update combination
    if (method === 'PUT' && pathParts.length === 4) {
      const combinationId = pathParts[3];
      const {
        name,
        description,
        layer_ids,
        tags,
        is_favorite
      } = req.body;

      // Verify ownership
      const ownerCheck = await db.query(
        'SELECT id FROM context_combinations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [combinationId, userId]
      );

      if (ownerCheck.rows.length === 0) {
        return res.status(404).json(error('Combination not found', 404));
      }

      // If updating layer_ids, verify they belong to user
      if (layer_ids) {
        if (!Array.isArray(layer_ids) || layer_ids.length === 0) {
          return res.status(400).json(error('layer_ids must be a non-empty array'));
        }

        const layerCheck = await db.query(
          `SELECT id FROM context_layers
           WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL`,
          [layer_ids, userId]
        );

        if (layerCheck.rows.length !== layer_ids.length) {
          return res.status(400).json(error('Some layer IDs are invalid or do not belong to you'));
        }
      }

      const updates = [];
      const params = [combinationId, userId];
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

      if (layer_ids !== undefined) {
        paramCount++;
        updates.push(`layer_ids = $${paramCount}`);
        params.push(layer_ids);
      }

      if (tags !== undefined) {
        paramCount++;
        updates.push(`tags = $${paramCount}`);
        params.push(tags);
      }

      if (is_favorite !== undefined) {
        paramCount++;
        updates.push(`is_favorite = $${paramCount}`);
        params.push(is_favorite);
      }

      if (updates.length === 0) {
        return res.status(400).json(error('No fields to update'));
      }

      updates.push('updated_at = NOW()');

      const result = await db.query(
        `UPDATE context_combinations
         SET ${updates.join(', ')}
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING *`,
        params
      );

      return res.json(success({ combination: result.rows[0] }));
    }

    // DELETE /api/contexts/combinations/:id - Soft delete combination
    if (method === 'DELETE' && pathParts.length === 4) {
      const combinationId = pathParts[3];

      const result = await db.query(
        `UPDATE context_combinations
         SET deleted_at = NOW()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id, name`,
        [combinationId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Combination not found', 404));
      }

      return res.json(success({
        id: result.rows[0].id,
        name: result.rows[0].name,
        deleted: true
      }));
    }

    // POST /api/contexts/combinations/:id/use - Track usage
    if (method === 'POST' && pathParts.length === 5 && pathParts[4] === 'use') {
      const combinationId = pathParts[3];

      const result = await db.query(
        `UPDATE context_combinations
         SET usage_count = usage_count + 1,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id, usage_count`,
        [combinationId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Combination not found', 404));
      }

      return res.json(success(result.rows[0]));
    }

    // POST /api/contexts/combinations/:id/favorite - Toggle favorite
    if (method === 'POST' && pathParts.length === 5 && pathParts[4] === 'favorite') {
      const combinationId = pathParts[3];

      const result = await db.query(
        `UPDATE context_combinations
         SET is_favorite = NOT is_favorite,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id, is_favorite`,
        [combinationId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Combination not found', 404));
      }

      return res.json(success(result.rows[0]));
    }

    // GET /api/contexts/combinations/:id/content - Get combined content for AI
    if (method === 'GET' && pathParts.length === 5 && pathParts[4] === 'content') {
      const combinationId = pathParts[3];

      // Get combination
      const comboResult = await db.query(
        `SELECT name, description, layer_ids FROM context_combinations
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [combinationId, userId]
      );

      if (comboResult.rows.length === 0) {
        return res.status(404).json(error('Combination not found', 404));
      }

      const combination = comboResult.rows[0];

      // Get layers in order
      const layersResult = await db.query(
        `SELECT name, layer_type, content, token_count
         FROM context_layers
         WHERE id = ANY($1) AND deleted_at IS NULL
         ORDER BY array_position($1, id)`,
        [combination.layer_ids]
      );

      // Format content for AI
      let combinedContent = `# ${combination.name}\n\n`;
      if (combination.description) {
        combinedContent += `${combination.description}\n\n`;
      }

      let totalTokens = 0;

      for (const layer of layersResult.rows) {
        combinedContent += `## ${layer.name} (${layer.layer_type})\n\n`;
        combinedContent += `${layer.content}\n\n`;
        combinedContent += '---\n\n';
        totalTokens += layer.token_count;
      }

      return res.json(success({
        content: combinedContent,
        total_tokens: totalTokens,
        layer_count: layersResult.rows.length
      }));
    }

    return res.status(404).json(error('Not found', 404));

  } catch (err) {
    console.error('Context Combinations API Error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
