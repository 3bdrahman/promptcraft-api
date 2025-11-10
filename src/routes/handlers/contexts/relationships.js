/**
 * Context Relationships API
 * Handles context dependencies and relationships
 */

import { db } from '../../../utils/database.js';
import { getUserId } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';

/**
 * GET /api/contexts/relationships
 * Get all relationships (optionally filtered)
 */
export async function getRelationships(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { source_id, target_id, relationship_type } = req.query;

    let query = `
      SELECT
        cr.*,
        cl_source.name as source_name,
        cl_target.name as target_name
      FROM context_relationships cr
      JOIN context_layers cl_source ON cr.source_id = cl_source.id
      JOIN context_layers cl_target ON cr.target_id = cl_target.id
      WHERE cl_source.user_id = $1 AND cl_source.deleted_at IS NULL
        AND cl_target.deleted_at IS NULL
    `;
    const params = [userId];
    let paramCount = 1;

    if (source_id) {
      paramCount++;
      query += ` AND cr.source_id = $${paramCount}`;
      params.push(source_id);
    }

    if (target_id) {
      paramCount++;
      query += ` AND cr.target_id = $${paramCount}`;
      params.push(target_id);
    }

    if (relationship_type) {
      paramCount++;
      query += ` AND cr.relationship_type = $${paramCount}`;
      params.push(relationship_type);
    }

    query += ' ORDER BY cr.created_at DESC';

    const result = await db.query(query, params);

    return res.json(success({ relationships: result.rows }));
  } catch (err) {
    console.error('Get relationships error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/relationships
 * Create a new relationship
 */
export async function createRelationship(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      source_id,
      target_id,
      relationship_type,
      strength = 1.0,
      is_bidirectional = false,
      reason,
      metadata = {}
    } = req.body;

    // Validation
    if (!source_id || !target_id || !relationship_type) {
      return res.status(400).json(error('source_id, target_id, and relationship_type are required'));
    }

    const validTypes = ['requires', 'extends', 'conflicts', 'recommends', 'uses', 'replaces'];
    if (!validTypes.includes(relationship_type)) {
      return res.status(400).json(error(`Invalid relationship_type. Must be one of: ${validTypes.join(', ')}`));
    }

    if (source_id === target_id) {
      return res.status(400).json(error('Cannot create self-referential relationship'));
    }

    // Verify ownership of both contexts
    const ownershipCheck = await db.query(
      `SELECT id FROM context_layers
       WHERE id IN ($1, $2) AND user_id = $3 AND deleted_at IS NULL`,
      [source_id, target_id, userId]
    );

    if (ownershipCheck.rows.length !== 2) {
      return res.status(404).json(error('One or both contexts not found', 404));
    }

    // Insert relationship
    const result = await db.query(
      `INSERT INTO context_relationships (
        source_id, target_id, relationship_type, strength,
        is_bidirectional, reason, metadata, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (source_id, target_id, relationship_type)
      DO UPDATE SET
        strength = $4,
        is_bidirectional = $5,
        reason = $6,
        metadata = $7
      RETURNING *`,
      [source_id, target_id, relationship_type, strength, is_bidirectional, reason, metadata, userId]
    );

    return res.status(201).json(success({ relationship: result.rows[0] }));
  } catch (err) {
    console.error('Create relationship error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * DELETE /api/contexts/relationships/:id
 * Delete a relationship
 */
export async function deleteRelationship(req, res, relationshipId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    // Verify ownership (user must own the source context)
    const result = await db.query(
      `DELETE FROM context_relationships cr
       USING context_layers cl
       WHERE cr.id = $1
         AND cr.source_id = cl.id
         AND cl.user_id = $2
         AND cl.deleted_at IS NULL
       RETURNING cr.*`,
      [relationshipId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Relationship not found', 404));
    }

    return res.json(success({ deleted: true, relationship: result.rows[0] }));
  } catch (err) {
    console.error('Delete relationship error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/layers/:id/dependencies
 * Resolve dependencies for a context
 */
export async function resolveDependencies(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { max_depth = 5, include_recommendations = false } = req.query;

    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [contextId, userId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    // Use the resolve_context_dependencies function from migration 009
    const result = await db.query(
      `SELECT
        cl.id, cl.name, cl.content, cl.token_count,
        d.depth, d.is_required, d.reason
       FROM resolve_context_dependencies(
         ARRAY[$1]::UUID[],
         $2::INT,
         $3::BOOLEAN
       ) d
       JOIN context_layers cl ON d.context_id = cl.id
       WHERE cl.deleted_at IS NULL
       ORDER BY d.depth, cl.name`,
      [contextId, max_depth, include_recommendations === 'true']
    );

    // Check for conflicts
    const conflicts = await db.query(
      `SELECT * FROM check_context_conflicts(
        ARRAY(SELECT context_id FROM resolve_context_dependencies(
          ARRAY[$1]::UUID[], $2::INT, false
        ))
      )`,
      [contextId, max_depth]
    );

    return res.json(success({
      resolved: result.rows,
      conflicts: conflicts.rows
    }));
  } catch (err) {
    console.error('Resolve dependencies error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/layers/:id/conflicts
 * Check for conflicts with other contexts
 */
export async function checkConflicts(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { context_ids } = req.query;

    if (!context_ids) {
      return res.status(400).json(error('context_ids query parameter is required'));
    }

    const contextIdsArray = Array.isArray(context_ids)
      ? context_ids
      : context_ids.split(',');

    // Add the main context to the array
    contextIdsArray.push(contextId);

    // Verify ownership of all contexts
    const ownershipCheck = await db.query(
      `SELECT id FROM context_layers
       WHERE id = ANY($1::UUID[]) AND user_id = $2 AND deleted_at IS NULL`,
      [contextIdsArray, userId]
    );

    if (ownershipCheck.rows.length !== contextIdsArray.length) {
      return res.status(404).json(error('One or more contexts not found', 404));
    }

    // Use the check_context_conflicts function from migration 009
    const result = await db.query(
      'SELECT * FROM check_context_conflicts($1::UUID[])',
      [contextIdsArray]
    );

    return res.json(success({ conflicts: result.rows }));
  } catch (err) {
    console.error('Check conflicts error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/layers/:id/order
 * Get dependency-respecting order for contexts
 */
export async function getDependencyOrder(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { context_ids } = req.query;

    if (!context_ids) {
      return res.status(400).json(error('context_ids query parameter is required'));
    }

    const contextIdsArray = Array.isArray(context_ids)
      ? context_ids
      : context_ids.split(',');

    // Add the main context
    contextIdsArray.push(contextId);

    // Verify ownership
    const ownershipCheck = await db.query(
      `SELECT id FROM context_layers
       WHERE id = ANY($1::UUID[]) AND user_id = $2 AND deleted_at IS NULL`,
      [contextIdsArray, userId]
    );

    if (ownershipCheck.rows.length !== contextIdsArray.length) {
      return res.status(404).json(error('One or more contexts not found', 404));
    }

    // Use the get_dependency_order function from migration 009
    const result = await db.query(
      `SELECT
        cl.id, cl.name, o.order_position
       FROM get_dependency_order($1::UUID[]) o
       JOIN context_layers cl ON o.context_id = cl.id
       ORDER BY o.order_position`,
      [contextIdsArray]
    );

    return res.json(success({ ordered: result.rows }));
  } catch (err) {
    console.error('Get dependency order error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
