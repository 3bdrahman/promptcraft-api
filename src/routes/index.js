/**
 * Main API Router
 * Converts Vercel serverless router to Express routes
 */

import express from 'express';

// Import all endpoint handlers
import templatesHandler from './handlers/templates.js';
import layersHandler from './handlers/layers.js';
import profilesHandler from './handlers/profiles.js';
import combinationsHandler from './handlers/combinations.js';
import snippetsHandler from './handlers/snippets.js';
import authByEmailHandler from './handlers/auth-by-email.js';
import subscriptionHandler from './handlers/subscription.js';
import analyticsHandler from './handlers/analytics.js';
import subscriptionsHandler from './handlers/subscriptions.js';

// Auth endpoints
import signupHandler from './handlers/auth/signup.js';
import loginHandler from './handlers/auth/login.js';
import refreshHandler from './handlers/auth/refresh.js';
import logoutHandler from './handlers/auth/logout.js';
import logoutAllHandler from './handlers/auth/logout-all.js';
import verifyPinHandler from './handlers/auth/verify-pin.js';
import resendPinHandler from './handlers/auth/resend-pin.js';

// Teams endpoints
import {
  getUserTeams,
  getTeam,
  createTeam,
  updateTeam,
  deleteTeam
} from './handlers/teams/index.js';

import {
  getTeamMembers,
  updateTeamMember,
  removeTeamMember
} from './handlers/teams/members.js';

import {
  getTeamInvitations,
  createTeamInvitation,
  getInvitationByToken,
  acceptInvitation,
  rejectInvitation,
  cancelInvitation
} from './handlers/teams/invitations.js';

// Context endpoints
import contextsRouter from './handlers/contexts/index.js';

// AI endpoints
import aiGenerateHandler from './handlers/ai/generate.js';
import aiEmbeddingsHandler from './handlers/ai/embeddings.js';
import aiProvidersHandler from './handlers/ai/providers.js';

const router = express.Router();

// Helper to wrap async handlers
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ============================================
// Authentication Routes
// ============================================
router.post('/auth/signup', asyncHandler(signupHandler));
router.post('/auth/login', asyncHandler(loginHandler));
router.post('/auth/refresh', asyncHandler(refreshHandler));
router.post('/auth/logout', asyncHandler(logoutHandler));
router.post('/auth/logout-all', asyncHandler(logoutAllHandler));
router.post('/auth/verify-pin', asyncHandler(verifyPinHandler));
router.post('/auth/resend-pin', asyncHandler(resendPinHandler));
router.post('/user/auth-by-email', asyncHandler(authByEmailHandler));

// ============================================
// Templates Routes
// ============================================
router.all('/templates*', asyncHandler(templatesHandler));

// ============================================
// Context Routes
// ============================================
router.all('/contexts/layers*', asyncHandler(layersHandler));
router.all('/contexts/profiles*', asyncHandler(profilesHandler));
router.all('/contexts/combinations*', asyncHandler(combinationsHandler));
router.all('/contexts/snippets*', asyncHandler(snippetsHandler));

// Advanced context routes (composition, relationships, versions, search)
router.use('/contexts', contextsRouter);

// ============================================
// Teams Routes
// ============================================

// Team CRUD
router.get('/teams', asyncHandler(getUserTeams));
router.get('/teams/:id', asyncHandler(getTeam));
router.post('/teams', asyncHandler(createTeam));
router.put('/teams/:id', asyncHandler(updateTeam));
router.delete('/teams/:id', asyncHandler(deleteTeam));

// Team Members
router.get('/teams/:id/members', asyncHandler(getTeamMembers));
router.put('/teams/:id/members/:userId', asyncHandler(updateTeamMember));
router.delete('/teams/:id/members/:userId', asyncHandler(removeTeamMember));

// Team Invitations
router.get('/teams/:id/invitations', asyncHandler(getTeamInvitations));
router.post('/teams/:id/invitations', asyncHandler(createTeamInvitation));
router.get('/invitations/:token', asyncHandler(getInvitationByToken));
router.post('/invitations/:token/accept', asyncHandler(acceptInvitation));
router.post('/invitations/:token/reject', asyncHandler(rejectInvitation));
router.delete('/invitations/:id', asyncHandler(cancelInvitation));

// ============================================
// Subscription Routes
// ============================================
router.all('/user/subscription*', asyncHandler(subscriptionHandler));
router.all('/subscriptions*', asyncHandler(subscriptionsHandler));

// ============================================
// Analytics Routes
// ============================================
router.all('/analytics*', asyncHandler(analyticsHandler));

// ============================================
// AI Routes (For Prompt Lab)
// ============================================
router.post('/ai/generate', asyncHandler(aiGenerateHandler));
router.post('/ai/embeddings', asyncHandler(aiEmbeddingsHandler));
router.get('/ai/providers', asyncHandler(aiProvidersHandler));

// ============================================
// Root API Info
// ============================================
router.get('/', (req, res) => {
  res.json({
    name: 'PromptCraft API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      auth: [
        'POST /api/auth/signup',
        'POST /api/auth/login',
        'POST /api/auth/refresh',
        'POST /api/auth/logout',
        'POST /api/auth/verify-pin',
        'POST /api/auth/resend-pin'
      ],
      templates: [
        'GET /api/templates',
        'POST /api/templates',
        'PUT /api/templates/:id',
        'DELETE /api/templates/:id'
      ],
      contexts: [
        'GET /api/contexts/layers',
        'POST /api/contexts/layers',
        'PUT /api/contexts/layers/:id',
        'DELETE /api/contexts/layers/:id'
      ],
      teams: [
        'GET /api/teams',
        'POST /api/teams',
        'GET /api/teams/:id',
        'PUT /api/teams/:id',
        'DELETE /api/teams/:id'
      ],
      ai: [
        'POST /api/ai/generate',
        'POST /api/ai/embeddings',
        'GET /api/ai/providers'
      ]
    }
  });
});

export default router;
