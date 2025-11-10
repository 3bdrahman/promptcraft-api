/**
 * Context Versions API
 * Git-like version control for contexts
 */

import { db } from '../../../utils/database.js';
import { getUserId } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';

/**
 * GET /api/contexts/layers/:id/versions
 * Get version history for a context
 */
export async function getVersionHistory(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      branch = 'main',
      limit = 50,
      offset = 0
    } = req.query;

    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [contextId, userId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    // Get versions
    const result = await db.query(
      `SELECT
        cv.*,
        u.username as created_by_username,
        LENGTH(cv.content) as content_length,
        LENGTH(cv.diff_from_parent) as diff_length
       FROM context_versions cv
       LEFT JOIN users u ON cv.created_by = u.id
       WHERE cv.context_id = $1 AND cv.branch_name = $2
       ORDER BY cv.version_number DESC
       LIMIT $3 OFFSET $4`,
      [contextId, branch, parseInt(limit), parseInt(offset)]
    );

    // Get total count
    const countResult = await db.query(
      'SELECT COUNT(*) FROM context_versions WHERE context_id = $1 AND branch_name = $2',
      [contextId, branch]
    );

    return res.json(success({
      versions: result.rows,
      total: parseInt(countResult.rows[0].count),
      branch
    }));
  } catch (err) {
    console.error('Get version history error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/layers/:id/versions/:versionId
 * Get a specific version
 */
export async function getVersion(req, res, contextId, versionId) {
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

    // Get version
    const result = await db.query(
      `SELECT
        cv.*,
        u.username as created_by_username
       FROM context_versions cv
       LEFT JOIN users u ON cv.created_by = u.id
       WHERE cv.id = $1 AND cv.context_id = $2`,
      [versionId, contextId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Version not found', 404));
    }

    return res.json(success({ version: result.rows[0] }));
  } catch (err) {
    console.error('Get version error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/layers/:id/revert/:versionId
 * Revert context to a specific version
 */
export async function revertToVersion(req, res, contextId, versionId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { commit_message = 'Reverted to previous version' } = req.body;

    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [contextId, userId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    // Get version to revert to
    const versionResult = await db.query(
      'SELECT * FROM context_versions WHERE id = $1 AND context_id = $2',
      [versionId, contextId]
    );

    if (versionResult.rows.length === 0) {
      return res.status(404).json(error('Version not found', 404));
    }

    const version = versionResult.rows[0];

    // Use the revert_to_version function from migration 010
    const revertResult = await db.query(
      'SELECT revert_to_version($1, $2, $3, $4) as new_version_id',
      [contextId, version.version_number, userId, commit_message]
    );

    // Get the new version
    const newVersionResult = await db.query(
      'SELECT * FROM context_versions WHERE id = $1',
      [revertResult.rows[0].new_version_id]
    );

    return res.json(success({
      reverted: true,
      new_version: newVersionResult.rows[0]
    }));
  } catch (err) {
    console.error('Revert to version error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/layers/:id/diff
 * Compare two versions
 */
export async function compareVersions(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { from_version, to_version } = req.query;

    if (!from_version || !to_version) {
      return res.status(400).json(error('from_version and to_version are required'));
    }

    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [contextId, userId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    // Use the compare_versions function from migration 010
    const result = await db.query(
      'SELECT * FROM compare_versions($1, $2::INT, $3::INT)',
      [contextId, parseInt(from_version), parseInt(to_version)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('One or both versions not found', 404));
    }

    return res.json(success(result.rows[0]));
  } catch (err) {
    console.error('Compare versions error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/layers/:id/branch
 * Create a new branch from current version
 */
export async function createBranch(req, res, contextId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      branch_name,
      from_version_number = null
    } = req.body;

    if (!branch_name) {
      return res.status(400).json(error('branch_name is required'));
    }

    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM context_layers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [contextId, userId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Context not found', 404));
    }

    // Use the create_version_branch function from migration 010
    const result = await db.query(
      'SELECT create_version_branch($1, $2, $3) as new_version_id',
      [contextId, branch_name, from_version_number]
    );

    // Get the new version
    const newVersionResult = await db.query(
      'SELECT * FROM context_versions WHERE id = $1',
      [result.rows[0].new_version_id]
    );

    return res.status(201).json(success({
      branch: branch_name,
      version: newVersionResult.rows[0]
    }));
  } catch (err) {
    console.error('Create branch error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/layers/:id/branches
 * Get all branches for a context
 */
export async function getBranches(req, res, contextId) {
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

    // Get all branches with latest version info
    const result = await db.query(
      `SELECT DISTINCT ON (branch_name)
        branch_name,
        version_number as latest_version,
        created_at as last_updated,
        created_by
       FROM context_versions
       WHERE context_id = $1
       ORDER BY branch_name, version_number DESC`,
      [contextId]
    );

    return res.json(success({ branches: result.rows }));
  } catch (err) {
    console.error('Get branches error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
