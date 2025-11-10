/**
 * Team Invitations API Endpoints
 * Handles team invitations
 */

import { db } from '../../../utils/database.js';
import { requireAuth } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';
import crypto from 'crypto';

/**
 * GET /api/teams/:teamId/invitations - Get team invitations
 */
export async function getTeamInvitations(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const teamId = req.params.teamId;

    // Check if user can manage invitations (owner or admin only)
    const roleCheck = await db.query(
      `SELECT tm.role
       FROM team_members tm
       WHERE tm.user_id = $1 AND tm.team_id = $2`,
      [userId, teamId]
    );

    if (roleCheck.rows.length === 0) {
      return res.status(403).json(error('You do not have access to this team', 403));
    }

    const canInvite = ['owner', 'admin'].includes(roleCheck.rows[0].role);

    if (!canInvite) {
      return res.status(403).json(error('You do not have permission to view invitations', 403));
    }

    // Get pending invitations
    const result = await db.query(
      `SELECT
        i.*,
        u_inviter.username as inviter_username
      FROM team_invitations i
      LEFT JOIN users u_inviter ON i.invited_by = u_inviter.id
      WHERE i.team_id = $1
        AND i.status IN ('pending', 'accepted')
      ORDER BY i.created_at DESC`,
      [teamId]
    );

    return res.json({
      success: true,
      invitations: result.rows
    });
  } catch (err) {
    console.error('Error fetching invitations:', err);
    return res.status(500).json(error('Failed to fetch invitations', 500));
  }
}

/**
 * POST /api/teams/:teamId/invitations - Invite user to team
 */
export async function createTeamInvitation(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const teamId = req.params.teamId;
    const { email, role = 'member' } = req.body;

    if (!email) {
      return res.status(400).json(error('Email is required', 400));
    }

    // Check if user can invite (owner or admin only)
    const roleCheck = await db.query(
      `SELECT tm.role
       FROM team_members tm
       WHERE tm.user_id = $1 AND tm.team_id = $2`,
      [userId, teamId]
    );

    if (roleCheck.rows.length === 0) {
      return res.status(403).json(error('You do not have access to this team', 403));
    }

    const canInvite = ['owner', 'admin'].includes(roleCheck.rows[0].role);

    if (!canInvite) {
      return res.status(403).json(error('You do not have permission to invite members', 403));
    }

    // Check if user already exists
    const userCheck = await db.query(
      `SELECT id FROM users WHERE email = $1`,
      [email]
    );

    const invitedUserId = userCheck.rows.length > 0 ? userCheck.rows[0].id : null;

    // Check if user is already a member
    if (invitedUserId) {
      const memberCheck = await db.query(
        `SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [teamId, invitedUserId]
      );

      if (memberCheck.rows.length > 0) {
        return res.status(400).json(error('User is already a team member', 400));
      }
    }

    // Check if invitation already exists
    const invitationCheck = await db.query(
      `SELECT id FROM team_invitations
       WHERE team_id = $1 AND invited_email = $2 AND status = 'pending'`,
      [teamId, email]
    );

    if (invitationCheck.rows.length > 0) {
      return res.status(400).json(error('An invitation has already been sent to this email', 400));
    }

    // Generate invitation token
    const token = crypto.randomBytes(32).toString('hex');

    // Create invitation
    const result = await db.query(
      `INSERT INTO team_invitations
        (team_id, invited_by, invited_user_id, invited_email, role, token)
       VALUES ($1, $2, $3, $4, $5::team_role, $6)
       RETURNING *`,
      [teamId, userId, invitedUserId, email, role, token]
    );

    // TODO: Send invitation email
    // await sendInvitationEmail(email, token, teamId);

    return res.json(success({
      invitation: result.rows[0],
      invitationUrl: `${process.env.APP_URL || 'http://localhost:3001'}/invitations/${token}`
    }));
  } catch (err) {
    console.error('Error creating invitation:', err);
    return res.status(500).json(error('Failed to create invitation', 500));
  }
}

/**
 * GET /api/invitations/:token - Get invitation details (public)
 */
export async function getInvitationByToken(req, res) {
  try {
    const token = req.params.token;

    const result = await db.query(
      `SELECT
        i.*,
        t.name as team_name,
        t.slug as team_slug,
        t.description as team_description,
        u.username as inviter_username
      FROM team_invitations i
      INNER JOIN teams t ON i.team_id = t.id
      INNER JOIN users u ON i.invited_by = u.id
      WHERE i.token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Invitation not found', 404));
    }

    const invitation = result.rows[0];

    // Check if expired
    if (new Date(invitation.expires_at) < new Date()) {
      await db.query(
        `UPDATE team_invitations SET status = 'expired' WHERE id = $1`,
        [invitation.id]
      );

      return res.status(400).json(error('This invitation has expired', 400));
    }

    // Check if already accepted or rejected
    if (invitation.status !== 'pending') {
      return res.status(400).json(error(`This invitation has already been ${invitation.status}`, 400));
    }

    return res.json(success(invitation));
  } catch (err) {
    console.error('Error fetching invitation:', err);
    return res.status(500).json(error('Failed to fetch invitation', 500));
  }
}

/**
 * POST /api/invitations/:token/accept - Accept team invitation
 */
export async function acceptInvitation(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const token = req.params.token;

    // Get invitation
    const invitationResult = await db.query(
      `SELECT * FROM team_invitations WHERE token = $1`,
      [token]
    );

    if (invitationResult.rows.length === 0) {
      return res.status(404).json(error('Invitation not found', 404));
    }

    const invitation = invitationResult.rows[0];

    // Verify invitation is still valid
    if (invitation.status !== 'pending') {
      return res.status(400).json(error(`Invitation has already been ${invitation.status}`, 400));
    }

    if (new Date(invitation.expires_at) < new Date()) {
      return res.status(400).json(error('This invitation has expired', 400));
    }

    // Check if user's email matches invitation
    const userResult = await db.query(
      `SELECT email FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows[0].email !== invitation.invited_email) {
      return res.status(403).json(error('This invitation was sent to a different email address', 403));
    }

    // Add user to team
    await db.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, $3::team_role)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [invitation.team_id, userId, invitation.role]
    );

    // Mark invitation as accepted
    await db.query(
      `UPDATE team_invitations
       SET status = 'accepted', accepted_at = NOW()
       WHERE id = $1`,
      [invitation.id]
    );

    // Get team details
    const teamResult = await db.query(
      `SELECT * FROM teams WHERE id = $1`,
      [invitation.team_id]
    );

    return res.json(success({
      team: teamResult.rows[0],
      message: 'Successfully joined team'
    }));
  } catch (err) {
    console.error('Error accepting invitation:', err);
    return res.status(500).json(error('Failed to accept invitation', 500));
  }
}

/**
 * POST /api/invitations/:token/reject - Reject team invitation
 */
export async function rejectInvitation(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const token = req.params.token;

    // Get invitation
    const invitationResult = await db.query(
      `SELECT * FROM team_invitations WHERE token = $1`,
      [token]
    );

    if (invitationResult.rows.length === 0) {
      return res.status(404).json(error('Invitation not found', 404));
    }

    const invitation = invitationResult.rows[0];

    // Verify user's email matches
    const userResult = await db.query(
      `SELECT email FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows[0].email !== invitation.invited_email) {
      return res.status(403).json(error('This invitation was sent to a different email address', 403));
    }

    // Mark as rejected
    await db.query(
      `UPDATE team_invitations SET status = 'rejected' WHERE id = $1`,
      [invitation.id]
    );

    return res.json(success({
      message: 'Invitation rejected'
    }));
  } catch (err) {
    console.error('Error rejecting invitation:', err);
    return res.status(500).json(error('Failed to reject invitation', 500));
  }
}

/**
 * DELETE /api/teams/:teamId/invitations/:invitationId - Cancel invitation
 */
export async function cancelInvitation(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const userId = user.id;
    const { teamId, invitationId } = req.params;

    // Check permissions
    const roleCheck = await db.query(
      `SELECT user_has_team_role($1, $2, 'admin') as has_permission`,
      [userId, teamId]
    );

    if (!roleCheck.rows[0].has_permission) {
      return res.status(403).json(error('Only admins can cancel invitations', 403));
    }

    // Delete invitation
    await db.query(
      `DELETE FROM team_invitations WHERE id = $1 AND team_id = $2`,
      [invitationId, teamId]
    );

    return res.json(success({
      message: 'Invitation cancelled'
    }));
  } catch (err) {
    console.error('Error cancelling invitation:', err);
    return res.status(500).json(error('Failed to cancel invitation', 500));
  }
}
