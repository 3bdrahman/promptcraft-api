/**
 * Context API Router
 * Routes context-related requests to appropriate handlers
 */

import { handleCors, error } from '../../../utils/responses.js';

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

/**
 * Route context requests
 */
export default async function contextsRouter(req, res, pathParts) {
  if (handleCors(req, res)) return;

  const { method } = req;

  try {
    // === COMPOSITION ENDPOINTS ===

    // GET /api/contexts/layers/:id/tree
    if (method === 'GET' && pathParts.length === 5 && pathParts[4] === 'tree') {
      return await getCompositionTree(req, res, pathParts[3]);
    }

    // POST /api/contexts/layers/:id/children
    if (method === 'POST' && pathParts.length === 5 && pathParts[4] === 'children') {
      return await addChild(req, res, pathParts[3]);
    }

    // DELETE /api/contexts/layers/:id/children/:childId
    if (method === 'DELETE' && pathParts.length === 6 && pathParts[4] === 'children') {
      return await removeChild(req, res, pathParts[3], pathParts[5]);
    }

    // PUT /api/contexts/layers/:id/order
    if (method === 'PUT' && pathParts.length === 5 && pathParts[4] === 'order') {
      return await reorderChildren(req, res, pathParts[3]);
    }

    // GET /api/contexts/layers/:id/descendants
    if (method === 'GET' && pathParts.length === 5 && pathParts[4] === 'descendants') {
      return await getDescendants(req, res, pathParts[3]);
    }

    // === RELATIONSHIP ENDPOINTS ===

    // GET /api/contexts/relationships
    if (method === 'GET' && pathParts.length === 3 && pathParts[2] === 'relationships') {
      return await getRelationships(req, res);
    }

    // POST /api/contexts/relationships
    if (method === 'POST' && pathParts.length === 3 && pathParts[2] === 'relationships') {
      return await createRelationship(req, res);
    }

    // DELETE /api/contexts/relationships/:id
    if (method === 'DELETE' && pathParts.length === 4 && pathParts[2] === 'relationships') {
      return await deleteRelationship(req, res, pathParts[3]);
    }

    // GET /api/contexts/layers/:id/dependencies
    if (method === 'GET' && pathParts.length === 5 && pathParts[4] === 'dependencies') {
      return await resolveDependencies(req, res, pathParts[3]);
    }

    // GET /api/contexts/layers/:id/conflicts
    if (method === 'GET' && pathParts.length === 5 && pathParts[4] === 'conflicts') {
      return await checkConflicts(req, res, pathParts[3]);
    }

    // GET /api/contexts/layers/:id/order
    if (method === 'GET' && pathParts.length === 5 && pathParts[4] === 'order') {
      return await getDependencyOrder(req, res, pathParts[3]);
    }

    // === VERSION CONTROL ENDPOINTS ===

    // GET /api/contexts/layers/:id/versions
    if (method === 'GET' && pathParts.length === 5 && pathParts[4] === 'versions') {
      return await getVersionHistory(req, res, pathParts[3]);
    }

    // GET /api/contexts/layers/:id/versions/:versionId
    if (method === 'GET' && pathParts.length === 6 && pathParts[4] === 'versions') {
      return await getVersion(req, res, pathParts[3], pathParts[5]);
    }

    // POST /api/contexts/layers/:id/revert/:versionId
    if (method === 'POST' && pathParts.length === 6 && pathParts[4] === 'revert') {
      return await revertToVersion(req, res, pathParts[3], pathParts[5]);
    }

    // GET /api/contexts/layers/:id/diff
    if (method === 'GET' && pathParts.length === 5 && pathParts[4] === 'diff') {
      return await compareVersions(req, res, pathParts[3]);
    }

    // POST /api/contexts/layers/:id/branch
    if (method === 'POST' && pathParts.length === 5 && pathParts[4] === 'branch') {
      return await createBranch(req, res, pathParts[3]);
    }

    // GET /api/contexts/layers/:id/branches
    if (method === 'GET' && pathParts.length === 5 && pathParts[4] === 'branches') {
      return await getBranches(req, res, pathParts[3]);
    }

    // === SEMANTIC SEARCH ENDPOINTS ===

    // POST /api/contexts/search
    if (method === 'POST' && pathParts.length === 3 && pathParts[2] === 'search') {
      return await semanticSearch(req, res);
    }

    // POST /api/contexts/recommend
    if (method === 'POST' && pathParts.length === 3 && pathParts[2] === 'recommend') {
      return await getRecommendations(req, res);
    }

    // GET /api/contexts/layers/:id/similar
    if (method === 'GET' && pathParts.length === 5 && pathParts[4] === 'similar') {
      return await findSimilar(req, res, pathParts[3]);
    }

    // GET /api/contexts/effectiveness
    if (method === 'GET' && pathParts.length === 3 && pathParts[2] === 'effectiveness') {
      return await getEffectivenessMetrics(req, res);
    }

    // POST /api/contexts/track-usage
    if (method === 'POST' && pathParts.length === 3 && pathParts[2] === 'track-usage') {
      return await trackUsage(req, res);
    }

    // GET /api/contexts/associations
    if (method === 'GET' && pathParts.length === 3 && pathParts[2] === 'associations') {
      return await getAssociations(req, res);
    }

    // POST /api/contexts/layers/:id/generate-embedding
    if (method === 'POST' && pathParts.length === 5 && pathParts[4] === 'generate-embedding') {
      return await queueEmbeddingGeneration(req, res, pathParts[3]);
    }

    // If no route matched, return 404
    return res.status(404).json(error('Context endpoint not found', 404));

  } catch (err) {
    console.error('Contexts router error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
