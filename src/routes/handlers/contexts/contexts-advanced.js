/**
 * Advanced Context Routes - Express Router
 * Converted from Vercel-style handler to Express router
 * Handles composition, relationships, versions, and search
 */

import express from 'express';

// Import composition handlers
import {
  getCompositionTree,
  addChild,
  removeChild,
  reorderChildren,
  getDescendants
} from './composition.js';

// Import relationship handlers
import {
  getRelationships,
  createRelationship,
  deleteRelationship,
  resolveDependencies,
  checkConflicts,
  getDependencyOrder
} from './relationships.js';

// Import version control handlers
import {
  getVersionHistory,
  getVersion,
  revertToVersion,
  compareVersions,
  createBranch,
  getBranches
} from './versions.js';

// Import search handlers
import {
  semanticSearch,
  getRecommendations,
  findSimilar,
  getEffectivenessMetrics,
  trackUsage,
  getAssociations,
  queueEmbeddingGeneration
} from './search.js';

// Import conversational builder handlers
import {
  startConversation,
  sendMessage,
  saveConversationContexts,
  getConversationHistory
} from './conversational_builder.js';

// Import extraction handlers
import {
  extractFromFile,
  extractFromText,
  extractFromURL,
  extractFromRepo
} from './extraction.js';

// Import predictive engine handlers
import {
  getPredictions,
  trackUsage as trackPredictiveUsage,
  getPatterns
} from './predictive.js';

// Import compression engine handlers
import {
  compressContexts,
  applyCompressions,
  getCompressionAnalytics
} from './compression.js';

// Import knowledge graph handlers
import {
  generateGraph,
  findPaths,
  getNeighbors
} from './knowledge_graph.js';

const router = express.Router();

// Helper to wrap async handlers
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res)).catch(next);
};

// ============================================
// COMPOSITION ENDPOINTS
// ============================================

// GET /api/contexts/layers/:id/tree
router.get('/layers/:id/tree', asyncHandler(async (req, res) => {
  return await getCompositionTree(req, res, req.params.id);
}));

// POST /api/contexts/layers/:id/children
router.post('/layers/:id/children', asyncHandler(async (req, res) => {
  return await addChild(req, res, req.params.id);
}));

// DELETE /api/contexts/layers/:id/children/:childId
router.delete('/layers/:id/children/:childId', asyncHandler(async (req, res) => {
  return await removeChild(req, res, req.params.id, req.params.childId);
}));

// PUT /api/contexts/layers/:id/order
router.put('/layers/:id/order', asyncHandler(async (req, res) => {
  return await reorderChildren(req, res, req.params.id);
}));

// GET /api/contexts/layers/:id/descendants
router.get('/layers/:id/descendants', asyncHandler(async (req, res) => {
  return await getDescendants(req, res, req.params.id);
}));

// ============================================
// RELATIONSHIP ENDPOINTS
// ============================================

// GET /api/contexts/relationships
router.get('/relationships', asyncHandler(async (req, res) => {
  return await getRelationships(req, res);
}));

// POST /api/contexts/relationships
router.post('/relationships', asyncHandler(async (req, res) => {
  return await createRelationship(req, res);
}));

// DELETE /api/contexts/relationships/:id
router.delete('/relationships/:id', asyncHandler(async (req, res) => {
  return await deleteRelationship(req, res, req.params.id);
}));

// GET /api/contexts/layers/:id/dependencies
router.get('/layers/:id/dependencies', asyncHandler(async (req, res) => {
  return await resolveDependencies(req, res, req.params.id);
}));

// GET /api/contexts/layers/:id/conflicts
router.get('/layers/:id/conflicts', asyncHandler(async (req, res) => {
  return await checkConflicts(req, res, req.params.id);
}));

// GET /api/contexts/layers/:id/order
router.get('/layers/:id/order', asyncHandler(async (req, res) => {
  return await getDependencyOrder(req, res, req.params.id);
}));

// ============================================
// VERSION CONTROL ENDPOINTS
// ============================================

// GET /api/contexts/layers/:id/versions
router.get('/layers/:id/versions', asyncHandler(async (req, res) => {
  return await getVersionHistory(req, res, req.params.id);
}));

// GET /api/contexts/layers/:id/versions/:versionId
router.get('/layers/:id/versions/:versionId', asyncHandler(async (req, res) => {
  return await getVersion(req, res, req.params.id, req.params.versionId);
}));

// POST /api/contexts/layers/:id/revert/:versionId
router.post('/layers/:id/revert/:versionId', asyncHandler(async (req, res) => {
  return await revertToVersion(req, res, req.params.id, req.params.versionId);
}));

// GET /api/contexts/layers/:id/diff
router.get('/layers/:id/diff', asyncHandler(async (req, res) => {
  return await compareVersions(req, res, req.params.id);
}));

// POST /api/contexts/layers/:id/branch
router.post('/layers/:id/branch', asyncHandler(async (req, res) => {
  return await createBranch(req, res, req.params.id);
}));

// GET /api/contexts/layers/:id/branches
router.get('/layers/:id/branches', asyncHandler(async (req, res) => {
  return await getBranches(req, res, req.params.id);
}));

// ============================================
// SEMANTIC SEARCH ENDPOINTS
// ============================================

// POST /api/contexts/search
router.post('/search', asyncHandler(async (req, res) => {
  return await semanticSearch(req, res);
}));

// POST /api/contexts/recommend
router.post('/recommend', asyncHandler(async (req, res) => {
  return await getRecommendations(req, res);
}));

// GET /api/contexts/layers/:id/similar
router.get('/layers/:id/similar', asyncHandler(async (req, res) => {
  return await findSimilar(req, res, req.params.id);
}));

// GET /api/contexts/effectiveness
router.get('/effectiveness', asyncHandler(async (req, res) => {
  return await getEffectivenessMetrics(req, res);
}));

// POST /api/contexts/track-usage
router.post('/track-usage', asyncHandler(async (req, res) => {
  return await trackUsage(req, res);
}));

// GET /api/contexts/associations
router.get('/associations', asyncHandler(async (req, res) => {
  return await getAssociations(req, res);
}));

// POST /api/contexts/layers/:id/generate-embedding
router.post('/layers/:id/generate-embedding', asyncHandler(async (req, res) => {
  return await queueEmbeddingGeneration(req, res, req.params.id);
}));

// ============================================
// CONVERSATIONAL CONTEXT BUILDER
// ============================================

// POST /api/contexts/conversation/start
router.post('/conversation/start', asyncHandler(async (req, res) => {
  return await startConversation(req, res);
}));

// POST /api/contexts/conversation/message
router.post('/conversation/message', asyncHandler(async (req, res) => {
  return await sendMessage(req, res);
}));

// POST /api/contexts/conversation/save
router.post('/conversation/save', asyncHandler(async (req, res) => {
  return await saveConversationContexts(req, res);
}));

// GET /api/contexts/conversation/:sessionId
router.get('/conversation/:sessionId', asyncHandler(async (req, res) => {
  return await getConversationHistory(req, res);
}));

// ============================================
// CONTEXT EXTRACTION (UNIVERSAL SMART IMPORT)
// ============================================

// POST /api/extraction/from-file
router.post('/extraction/from-file', asyncHandler(async (req, res) => {
  return await extractFromFile(req, res);
}));

// POST /api/extraction/from-text
router.post('/extraction/from-text', asyncHandler(async (req, res) => {
  return await extractFromText(req, res);
}));

// POST /api/extraction/from-url
router.post('/extraction/from-url', asyncHandler(async (req, res) => {
  return await extractFromURL(req, res);
}));

// POST /api/extraction/from-repo
router.post('/extraction/from-repo', asyncHandler(async (req, res) => {
  return await extractFromRepo(req, res);
}));

// ============================================
// PREDICTIVE CONTEXT ENGINE
// ============================================

// POST /api/contexts/predictive/predict
router.post('/predictive/predict', asyncHandler(async (req, res) => {
  return await getPredictions(req, res);
}));

// POST /api/contexts/predictive/track
router.post('/predictive/track', asyncHandler(async (req, res) => {
  return await trackPredictiveUsage(req, res);
}));

// GET /api/contexts/predictive/patterns
router.get('/predictive/patterns', asyncHandler(async (req, res) => {
  return await getPatterns(req, res);
}));

// ============================================
// COMPRESSION ENGINE
// ============================================

// POST /api/contexts/compress
router.post('/compress', asyncHandler(async (req, res) => {
  return await compressContexts(req, res);
}));

// POST /api/contexts/compress/apply
router.post('/compress/apply', asyncHandler(async (req, res) => {
  return await applyCompressions(req, res);
}));

// GET /api/contexts/compress/analytics
router.get('/compress/analytics', asyncHandler(async (req, res) => {
  return await getCompressionAnalytics(req, res);
}));

// ============================================
// KNOWLEDGE GRAPH
// ============================================

// POST /api/contexts/graph/generate
router.post('/graph/generate', asyncHandler(async (req, res) => {
  return await generateGraph(req, res);
}));

// POST /api/contexts/graph/paths
router.post('/graph/paths', asyncHandler(async (req, res) => {
  return await findPaths(req, res);
}));

// GET /api/contexts/graph/neighbors/:contextId
router.get('/graph/neighbors/:contextId', asyncHandler(async (req, res) => {
  return await getNeighbors(req, res);
}));

export default router;
