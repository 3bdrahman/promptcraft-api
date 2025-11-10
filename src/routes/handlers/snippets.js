/**
 * Context Snippets API
 * Manages reusable context snippets
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

    // GET /api/contexts/snippets - List snippets with filters
    if (method === 'GET' && pathParts.length === 3) {
      const { category, tags, favorite, search, limit = 50, offset = 0 } = req.query;

      let query = 'SELECT * FROM context_snippets WHERE user_id = $1';
      const params = [userId];
      let paramCount = 1;

      // Apply filters
      if (category) {
        paramCount++;
        query += ` AND category = $${paramCount}`;
        params.push(category);
      }

      if (tags) {
        paramCount++;
        query += ` AND tags && $${paramCount}`;
        params.push(tags.split(','));
      }

      if (favorite === 'true') {
        query += ` AND is_favorite = true`;
      }

      if (search) {
        paramCount++;
        query += ` AND (name ILIKE $${paramCount} OR content ILIKE $${paramCount})`;
        params.push(`%${search}%`);
      }

      // Order and pagination
      query += ' ORDER BY is_favorite DESC, usage_count DESC, updated_at DESC';

      paramCount++;
      query += ` LIMIT $${paramCount}`;
      params.push(parseInt(limit));

      paramCount++;
      query += ` OFFSET $${paramCount}`;
      params.push(parseInt(offset));

      const result = await db.query(query, params);

      // Get total count
      let countQuery = 'SELECT COUNT(*) FROM context_snippets WHERE user_id = $1';
      const countParams = [userId];
      const countResult = await db.query(countQuery, countParams);

      return res.json(success({
        snippets: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }));
    }

    // GET /api/contexts/snippets/:id - Get single snippet
    if (method === 'GET' && pathParts.length === 4) {
      const snippetId = pathParts[3];

      const result = await db.query(
        'SELECT * FROM context_snippets WHERE id = $1 AND user_id = $2',
        [snippetId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Snippet not found', 404));
      }

      return res.json(success({ snippet: result.rows[0] }));
    }

    // POST /api/contexts/snippets - Create snippet
    if (method === 'POST' && pathParts.length === 3) {
      const {
        name,
        description,
        content,
        category,
        tags = [],
        is_favorite = false,
        project_ids = []
      } = req.body;

      if (!name || !content || !category) {
        return res.status(400).json(error('Name, content, and category are required'));
      }

      // Calculate token count
      const token_count = Math.ceil(content.length / 4);

      const result = await db.query(
        `INSERT INTO context_snippets (
          user_id, name, description, content, category, tags,
          is_favorite, token_count, project_ids
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`,
        [userId, name, description, content, category, tags, is_favorite, token_count, project_ids]
      );

      return res.status(201).json(success({ snippet: result.rows[0] }));
    }

    // PUT /api/contexts/snippets/:id - Update snippet
    if (method === 'PUT' && pathParts.length === 4) {
      const snippetId = pathParts[3];
      const {
        name,
        description,
        content,
        category,
        tags,
        is_favorite,
        project_ids
      } = req.body;

      const updates = [];
      const params = [snippetId, userId];
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

      if (category !== undefined) {
        paramCount++;
        updates.push(`category = $${paramCount}`);
        params.push(category);
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

      if (project_ids !== undefined) {
        paramCount++;
        updates.push(`project_ids = $${paramCount}`);
        params.push(project_ids);
      }

      if (updates.length === 0) {
        return res.status(400).json(error('No fields to update'));
      }

      updates.push('updated_at = NOW()');

      const result = await db.query(
        `UPDATE context_snippets
         SET ${updates.join(', ')}
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Snippet not found', 404));
      }

      return res.json(success({ snippet: result.rows[0] }));
    }

    // DELETE /api/contexts/snippets/:id - Delete snippet
    if (method === 'DELETE' && pathParts.length === 4) {
      const snippetId = pathParts[3];

      const result = await db.query(
        'DELETE FROM context_snippets WHERE id = $1 AND user_id = $2 RETURNING id',
        [snippetId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Snippet not found', 404));
      }

      return res.json(success({ id: result.rows[0].id }));
    }

    // POST /api/contexts/snippets/:id/use - Track usage
    if (method === 'POST' && pathParts.length === 5 && pathParts[4] === 'use') {
      const snippetId = pathParts[3];

      const result = await db.query(
        `UPDATE context_snippets
         SET usage_count = usage_count + 1,
             last_used_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, usage_count, last_used_at`,
        [snippetId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Snippet not found', 404));
      }

      return res.json(success(result.rows[0]));
    }

    // POST /api/contexts/snippets/:id/favorite - Toggle favorite
    if (method === 'POST' && pathParts.length === 5 && pathParts[4] === 'favorite') {
      const snippetId = pathParts[3];

      const result = await db.query(
        `UPDATE context_snippets
         SET is_favorite = NOT is_favorite,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, is_favorite`,
        [snippetId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Snippet not found', 404));
      }

      return res.json(success(result.rows[0]));
    }

    return res.status(404).json(error('Not found', 404));

  } catch (err) {
    console.error('Snippets API Error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
