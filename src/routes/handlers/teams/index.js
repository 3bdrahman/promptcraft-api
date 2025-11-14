/**
 * Teams API Endpoints
 * Handles team CRUD operations
 */

import { db } from '../../../utils/database.js';
import { requireAuth } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';

/**
 * GET /api/teams - Get user's teams
 */
export async function getUserTeams(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;

    const result = await db.query(
      `SELECT * FROM get_user_teams($1)`,
      [userId]
    );

    return res.json({
      success: true,
      teams: result.rows
    });
  } catch (err) {
    console.error('Error fetching user teams:', err);
    return res.status(500).json(error('Failed to fetch teams', 500));
  }
}

/**
 * GET /api/teams/:id - Get team details
 */
export async function getTeam(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const teamId = req.params.id;

    // Check if user has access to this team (is a member)
    const accessCheck = await db.query(
      `SELECT EXISTS(
        SELECT 1 FROM team_members
        WHERE team_id = $1 AND user_id = $2
      ) as has_access`,
      [teamId, userId]
    );

    if (!accessCheck.rows[0].has_access) {
      return res.status(403).json(error('You do not have access to this team', 403));
    }

    // Get team details with user's role
    const teamResult = await db.query(
      `SELECT t.*,
        (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count,
        tm.role
      FROM teams t
      LEFT JOIN team_members tm ON t.id = tm.team_id AND tm.user_id = $1
      WHERE t.id = $2 AND t.deleted_at IS NULL`,
      [userId, teamId]
    );

    if (teamResult.rows.length === 0) {
      return res.status(404).json(error('Team not found', 404));
    }

    return res.json(success(teamResult.rows[0]));
  } catch (err) {
    console.error('Error fetching team:', err);
    return res.status(500).json(error('Failed to fetch team', 500));
  }
}

/**
 * POST /api/teams - Create a new team
 */
export async function createTeam(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json(error('Team name is required', 400));
    }

    // Auto-generate slug from name
    let slug = name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    // Ensure slug is unique by checking and appending number if needed
    let slugExists = true;
    let slugAttempt = slug;
    let counter = 1;

    while (slugExists) {
      const checkResult = await db.query(
        `SELECT id FROM teams WHERE slug = $1`,
        [slugAttempt]
      );

      if (checkResult.rows.length === 0) {
        slugExists = false;
        slug = slugAttempt;
      } else {
        slugAttempt = `${slug}-${counter}`;
        counter++;
      }
    }

    // Create team
    const result = await db.query(
      `INSERT INTO teams (name, slug, description, created_by, owner_id)
       VALUES ($1, $2, $3, $4, $4)
       RETURNING *`,
      [name, slug, description || null, userId]
    );

    return res.json(success(result.rows[0]));
  } catch (err) {
    console.error('Error creating team:', err);
    return res.status(500).json(error('Failed to create team', 500));
  }
}

/**
 * PUT /api/teams/:id - Update team
 */
export async function updateTeam(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const teamId = req.params.id;
    const { name, description } = req.body;

    // Check if user is owner or admin
    const roleCheck = await db.query(
      `SELECT role FROM team_members
       WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId]
    );

    if (roleCheck.rows.length === 0 || !['admin', 'owner'].includes(roleCheck.rows[0].role)) {
      return res.status(403).json(error('Only team owners and admins can update team details', 403));
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }

    if (updates.length === 0) {
      return res.status(400).json(error('No fields to update', 400));
    }

    values.push(teamId);

    const result = await db.query(
      `UPDATE teams
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramIndex} AND deleted_at IS NULL
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Team not found', 404));
    }

    return res.json(success(result.rows[0]));
  } catch (err) {
    console.error('Error updating team:', err);
    return res.status(500).json(error('Failed to update team', 500));
  }
}

/**
 * DELETE /api/teams/:id - Delete team
 */
export async function deleteTeam(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const teamId = req.params.id;

    // Only owner can delete team
    const ownerCheck = await db.query(
      `SELECT created_by FROM teams WHERE id = $1`,
      [teamId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json(error('Team not found', 404));
    }

    if (ownerCheck.rows[0].created_by !== userId) {
      return res.status(403).json(error('Only team owner can delete the team', 403));
    }

    // Delete team (CASCADE will remove members and invitations)
    await db.query(
      `DELETE FROM teams WHERE id = $1`,
      [teamId]
    );

    return res.json(success({ message: 'Team deleted successfully' }));
  } catch (err) {
    console.error('Error deleting team:', err);
    return res.status(500).json(error('Failed to delete team', 500));
  }
}
