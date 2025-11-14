/**
 * Team Members API Endpoints
 * Handles team member management
 */

import { db } from '../../../utils/database.js';
import { requireAuth } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';

/**
 * GET /api/teams/:teamId/members - Get team members
 */
export async function getTeamMembers(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const teamId = req.params.teamId;

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

    // Get team members with user details
    const result = await db.query(
      `SELECT
        tm.id,
        tm.team_id,
        tm.user_id,
        tm.role,
        tm.joined_at,
        u.username,
        u.email
      FROM team_members tm
      INNER JOIN users u ON tm.user_id = u.id
      WHERE tm.team_id = $1
      ORDER BY
        CASE tm.role
          WHEN 'owner' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'member' THEN 3
          WHEN 'viewer' THEN 4
        END,
        tm.joined_at ASC`,
      [teamId]
    );

    return res.json({
      success: true,
      members: result.rows
    });
  } catch (err) {
    console.error('Error fetching team members:', err);
    return res.status(500).json(error('Failed to fetch team members', 500));
  }
}

/**
 * PUT /api/teams/:teamId/members/:memberId - Update member role/permissions
 */
export async function updateTeamMember(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const { teamId, memberId } = req.params;
    const { role, permissions } = req.body;

    // Check if requesting user is admin or owner
    const roleCheck = await db.query(
      `SELECT role FROM team_members
       WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId]
    );

    if (roleCheck.rows.length === 0 || !['admin', 'owner'].includes(roleCheck.rows[0].role)) {
      return res.status(403).json(error('Only team admins and owners can modify member roles', 403));
    }

    // Get current member info
    const memberInfo = await db.query(
      `SELECT user_id, role FROM team_members WHERE id = $1 AND team_id = $2`,
      [memberId, teamId]
    );

    if (memberInfo.rows.length === 0) {
      return res.status(404).json(error('Team member not found', 404));
    }

    // Can't change owner role or demote yourself if you're the only owner
    if (memberInfo.rows[0].role === 'owner') {
      return res.status(403).json(error('Cannot modify team owner', 403));
    }

    // Build update query
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (role !== undefined) {
      updates.push(`role = $${paramIndex++}::team_role`);
      values.push(role);
    }
    if (permissions !== undefined) {
      updates.push(`permissions = $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(permissions));
    }

    if (updates.length === 0) {
      return res.status(400).json(error('No fields to update', 400));
    }

    values.push(memberId);
    values.push(teamId);

    const result = await db.query(
      `UPDATE team_members
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramIndex++} AND team_id = $${paramIndex}
       RETURNING *`,
      values
    );

    return res.json(success(result.rows[0]));
  } catch (err) {
    console.error('Error updating team member:', err);
    return res.status(500).json(error('Failed to update team member', 500));
  }
}

/**
 * DELETE /api/teams/:teamId/members/:memberId - Remove member from team
 */
export async function removeTeamMember(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const { teamId, memberId } = req.params;

    // Get member info
    const memberInfo = await db.query(
      `SELECT user_id, role FROM team_members WHERE id = $1 AND team_id = $2`,
      [memberId, teamId]
    );

    if (memberInfo.rows.length === 0) {
      return res.status(404).json(error('Team member not found', 404));
    }

    const memberUserId = memberInfo.rows[0].user_id;
    const memberRole = memberInfo.rows[0].role;

    // Can't remove owner
    if (memberRole === 'owner') {
      return res.status(403).json(error('Cannot remove team owner', 403));
    }

    // Check permissions - either removing yourself or you're an admin
    const isRemovingSelf = memberUserId === userId;
    if (!isRemovingSelf) {
      const roleCheck = await db.query(
        `SELECT role FROM team_members
         WHERE team_id = $1 AND user_id = $2`,
        [teamId, userId]
      );

      if (roleCheck.rows.length === 0 || !['admin', 'owner'].includes(roleCheck.rows[0].role)) {
        return res.status(403).json(error('Only team admins can remove members', 403));
      }
    }

    // Remove member
    await db.query(
      `DELETE FROM team_members WHERE id = $1`,
      [memberId]
    );

    return res.json(success({
      message: 'Member removed successfully'
    }));
  } catch (err) {
    console.error('Error removing team member:', err);
    return res.status(500).json(error('Failed to remove team member', 500));
  }
}
