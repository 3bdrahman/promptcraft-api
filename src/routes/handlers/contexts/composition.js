/**
 * Context Composition API
 * Handles hierarchical context composition
 */

import { db } from '../../../utils/database.js';
import { getUserId } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';

/**
 * GET /api/contexts/layers/:id/tree
 * Get composition tree for a context
 */
export async function getCompositionTree(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [contextId, userId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    // Use the get_composition_tree function from migration 008
    const result = await db.query(
      'SELECT get_composition_tree($1) as tree',
      [contextId]
    );

    return res.json(success({ tree: result.rows[0].tree }));
  } catch (err) {
    console.error('Get composition tree error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/layers/:id/children
 * Add child context to parent
 */
export async function addChild(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { child_id, composition_order = 0, is_required = true } = req.body;

    if (!child_id) {
      return res.status(400).json(error('child_id is required'));
    }

    // Verify ownership of both parent and child
    const ownershipCheck = await db.query(
      `SELECT id FROM context_layers
       WHERE id IN ($1, $2) AND user_id = $3 AND deleted_at IS NULL`,
      [contextId, child_id, userId]
    );

    if (ownershipCheck.rows.length !== 2) {
      return res.status(404).json(error('Context not found or unauthorized', 404));
    }

    // Insert composition relationship
    const result = await db.query(
      `INSERT INTO context_composition (
        parent_id, child_id, composition_order, is_required, created_by
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (parent_id, child_id)
      DO UPDATE SET composition_order = $3, is_required = $4
      RETURNING *`,
      [contextId, child_id, composition_order, is_required, userId]
    );

    return res.status(201).json(success({ composition: result.rows[0] }));
  } catch (err) {
    console.error('Add child context error:', err);

    // Handle circular reference error
    if (err.message && err.message.includes('Circular reference')) {
      return res.status(400).json(error('Cannot add child: would create circular reference', 400));
    }

    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * DELETE /api/contexts/layers/:id/children/:childId
 * Remove child from parent
 */
export async function removeChild(req, res, contextId, childId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [contextId, userId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    // Delete composition
    const result = await db.query(
      `DELETE FROM context_composition
       WHERE parent_id = $1 AND child_id = $2
       RETURNING *`,
      [contextId, childId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Composition relationship not found', 404));
    }

    return res.json(success({ deleted: true, composition: result.rows[0] }));
  } catch (err) {
    console.error('Remove child context error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * PUT /api/contexts/layers/:id/order
 * Reorder children
 */
export async function reorderChildren(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { children } = req.body;

    if (!Array.isArray(children)) {
      return res.status(400).json(error('children must be an array', 400));
    }

    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [contextId, userId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    // Update each child's composition_order
    const updatePromises = children.map(({ child_id, composition_order }) =>
      db.query(
        `UPDATE context_composition
         SET composition_order = $3
         WHERE parent_id = $1 AND child_id = $2
         RETURNING *`,
        [contextId, child_id, composition_order]
      )
    );

    const results = await Promise.all(updatePromises);
    const updated = results.map(r => r.rows[0]).filter(Boolean);

    return res.json(success({ updated: updated.length, compositions: updated }));
  } catch (err) {
    console.error('Reorder children error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/layers/:id/descendants
 * Get all descendants of a context
 */
export async function getDescendants(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [contextId, userId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    // Use the get_context_descendants function from migration 008
    const result = await db.query(
      `SELECT
        cl.id, cl.name, cl.content, cl.token_count, cl.layer_type,
        d.depth, d.path
       FROM get_context_descendants($1) d
       JOIN context_layers cl ON d.context_id = cl.id
       WHERE cl.deleted_at IS NULL
       ORDER BY d.depth, cl.name`,
      [contextId]
    );

    return res.json(success({ descendants: result.rows }));
  } catch (err) {
    console.error('Get descendants error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
