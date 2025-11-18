/**
 * Knowledge Graph Handler
 *
 * Generate and query interactive knowledge graphs showing semantic
 * relationships between contexts
 *
 * @module handlers/contexts/knowledge_graph
 */

import { db } from '../../../utils/database.js';
import { getUserId } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';

/**
 * POST /api/contexts/graph/generate
 * Generate knowledge graph for user's contexts
 *
 * Body:
 * - context_ids: (optional) Specific contexts to include, or all if omitted
 * - min_similarity: Minimum similarity for edges (default 0.70)
 * - max_edges_per_node: Maximum edges per node (default 10)
 * - include_metadata: Include full context metadata (default true)
 */
export async function generateGraph(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      context_ids,
      min_similarity = 0.70,
      max_edges_per_node = 10,
      include_metadata = true
    } = req.body;

    const startTime = Date.now();

    // Get contexts with embeddings
    let contextsQuery;
    let contextsParams;

    if (context_ids && context_ids.length > 0) {
      contextsQuery = `
        SELECT
          cl.id as context_id,
          cl.name,
          cl.description,
          cl.layer_type,
          cl.tags,
          cl.usage_count,
          cl.token_count,
          ce.embedding
        FROM context_layers cl
        INNER JOIN context_embeddings ce ON ce.context_id = cl.id
        WHERE cl.user_id = $1
          AND cl.is_active = true
          AND cl.id = ANY($2::UUID[])
      `;
      contextsParams = [userId, context_ids];
    } else {
      contextsQuery = `
        SELECT
          cl.id as context_id,
          cl.name,
          cl.description,
          cl.layer_type,
          cl.tags,
          cl.usage_count,
          cl.token_count,
          ce.embedding
        FROM context_layers cl
        INNER JOIN context_embeddings ce ON ce.context_id = cl.id
        WHERE cl.user_id = $1
          AND cl.is_active = true
        LIMIT 200
      `;
      contextsParams = [userId];
    }

    const contextsResult = await db.query(contextsQuery, contextsParams);

    if (contextsResult.rows.length === 0) {
      return res.status(400).json(error('No contexts found with embeddings'));
    }

    const contexts = contextsResult.rows;

    // Build nodes
    const nodes = contexts.map((ctx, index) => ({
      id: ctx.context_id,
      label: ctx.name,
      type: ctx.layer_type,
      group: getNodeGroup(ctx.layer_type),
      size: calculateNodeSize(ctx.usage_count, ctx.token_count),
      ...(include_metadata && {
        description: ctx.description,
        tags: ctx.tags,
        usage_count: ctx.usage_count,
        token_count: ctx.token_count
      })
    }));

    // Build edges (calculate similarities)
    const edges = [];
    const edgeCount = {};

    for (let i = 0; i < contexts.length; i++) {
      edgeCount[contexts[i].context_id] = 0;
    }

    for (let i = 0; i < contexts.length; i++) {
      const similarities = [];

      for (let j = i + 1; j < contexts.length; j++) {
        // Calculate similarity using PostgreSQL vector operations
        const simResult = await db.query(
          `SELECT 1 - ($1::vector(384) <=> $2::vector(384)) as similarity`,
          [contexts[i].embedding, contexts[j].embedding]
        );

        const similarity = parseFloat(simResult.rows[0].similarity);

        if (similarity >= min_similarity) {
          similarities.push({
            source: contexts[i].context_id,
            target: contexts[j].context_id,
            similarity
          });
        }
      }

      // Sort by similarity and take top edges
      similarities.sort((a, b) => b.similarity - a.similarity);

      for (const sim of similarities) {
        // Check edge limits for both nodes
        if (edgeCount[sim.source] < max_edges_per_node &&
            edgeCount[sim.target] < max_edges_per_node) {
          edges.push({
            id: `${sim.source}-${sim.target}`,
            source: sim.source,
            target: sim.target,
            weight: sim.similarity,
            strength: getEdgeStrength(sim.similarity)
          });

          edgeCount[sim.source]++;
          edgeCount[sim.target]++;
        }
      }
    }

    // Identify clusters (simple clustering by layer_type and similarity)
    const clusters = identifyClusters(nodes, edges);

    return res.json(success({
      nodes,
      edges,
      clusters,
      metadata: {
        total_nodes: nodes.length,
        total_edges: edges.length,
        total_clusters: clusters.length,
        min_similarity,
        max_edges_per_node,
        generation_time_ms: Date.now() - startTime
      }
    }));

  } catch (err) {
    console.error('Generate graph error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/graph/paths
 * Find paths between two contexts
 *
 * Body:
 * - source_id: Source context ID
 * - target_id: Target context ID
 * - max_depth: Maximum path depth (default 5)
 * - min_similarity: Minimum similarity for edges (default 0.70)
 */
export async function findPaths(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      source_id,
      target_id,
      max_depth = 5,
      min_similarity = 0.70
    } = req.body;

    if (!source_id || !target_id) {
      return res.status(400).json(error('source_id and target_id are required'));
    }

    // Verify both contexts belong to user
    const verifyResult = await db.query(
      `SELECT context_id, name
       FROM context_layers
       WHERE user_id = $1
         AND context_id IN ($2, $3)
         AND is_active = true`,
      [userId, source_id, target_id]
    );

    if (verifyResult.rows.length !== 2) {
      return res.status(404).json(error('One or both contexts not found'));
    }

    // Find paths using breadth-first search
    const paths = await findShortestPaths(
      userId,
      source_id,
      target_id,
      max_depth,
      min_similarity
    );

    return res.json(success({
      source_id,
      target_id,
      paths,
      total_paths: paths.length,
      shortest_path_length: paths.length > 0 ? paths[0].length : null
    }));

  } catch (err) {
    console.error('Find paths error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/graph/neighbors/:contextId
 * Get neighboring contexts for a specific context
 *
 * Query params:
 * - min_similarity: Minimum similarity (default 0.70)
 * - limit: Maximum neighbors to return (default 10)
 */
export async function getNeighbors(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { contextId } = req.params;
    const {
      min_similarity = 0.70,
      limit = 10
    } = req.query;

    // Get the source context's embedding
    const sourceResult = await db.query(
      `SELECT ce.embedding, cl.name
       FROM context_embeddings ce
       INNER JOIN context_layers cl ON cl.id = ce.context_id
       WHERE ce.context_id = $1 AND cl.user_id = $2`,
      [contextId, userId]
    );

    if (sourceResult.rows.length === 0) {
      return res.status(404).json(error('Context not found'));
    }

    const sourceEmbedding = sourceResult.rows[0].embedding;
    const sourceName = sourceResult.rows[0].name;

    // Find similar contexts
    const neighborsResult = await db.query(
      `SELECT
         cl.id as context_id,
         cl.name,
         cl.description,
         cl.layer_type,
         cl.tags,
         cl.usage_count,
         1 - (ce.embedding <=> $1) as similarity
       FROM context_layers cl
       INNER JOIN context_embeddings ce ON ce.context_id = cl.id
       WHERE cl.user_id = $2
         AND cl.is_active = true
         AND cl.id != $3
         AND (1 - (ce.embedding <=> $1)) >= $4
       ORDER BY similarity DESC
       LIMIT $5`,
      [sourceEmbedding, userId, contextId, parseFloat(min_similarity), parseInt(limit)]
    );

    return res.json(success({
      source_context_id: contextId,
      source_context_name: sourceName,
      neighbors: neighborsResult.rows.map(row => ({
        context_id: row.context_id,
        name: row.name,
        description: row.description,
        layer_type: row.layer_type,
        tags: row.tags,
        usage_count: row.usage_count,
        similarity: parseFloat(row.similarity),
        strength: getEdgeStrength(parseFloat(row.similarity))
      })),
      total: neighborsResult.rows.length
    }));

  } catch (err) {
    console.error('Get neighbors error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * Helper: Calculate node size based on usage and token count
 */
function calculateNodeSize(usageCount, tokenCount) {
  const usageFactor = Math.min(usageCount || 0, 100) / 100;
  const tokenFactor = Math.min(tokenCount || 0, 5000) / 5000;

  // Size between 1 and 3
  return 1 + (usageFactor * 1) + (tokenFactor * 1);
}

/**
 * Helper: Get node group for coloring
 */
function getNodeGroup(layerType) {
  const groups = {
    profile: 1,
    project: 2,
    task: 3,
    snippet: 4,
    adhoc: 5,
    reference: 6
  };
  return groups[layerType] || 0;
}

/**
 * Helper: Get edge strength category
 */
function getEdgeStrength(similarity) {
  if (similarity >= 0.90) return 'very_strong';
  if (similarity >= 0.80) return 'strong';
  if (similarity >= 0.70) return 'moderate';
  return 'weak';
}

/**
 * Helper: Identify clusters in the graph
 */
function identifyClusters(nodes, edges) {
  // Simple clustering by layer_type
  const typeGroups = {};

  for (const node of nodes) {
    if (!typeGroups[node.type]) {
      typeGroups[node.type] = [];
    }
    typeGroups[node.type].push(node.id);
  }

  // Additionally, identify connected components
  const visited = new Set();
  const clusters = [];

  function dfs(nodeId, cluster) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    cluster.push(nodeId);

    // Find connected nodes
    for (const edge of edges) {
      if (edge.source === nodeId && !visited.has(edge.target)) {
        dfs(edge.target, cluster);
      }
      if (edge.target === nodeId && !visited.has(edge.source)) {
        dfs(edge.source, cluster);
      }
    }
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      const cluster = [];
      dfs(node.id, cluster);
      if (cluster.length >= 2) {
        clusters.push({
          id: `cluster-${clusters.length}`,
          nodes: cluster,
          size: cluster.length
        });
      }
    }
  }

  return clusters;
}

/**
 * Helper: Find shortest paths between two contexts
 */
async function findShortestPaths(userId, sourceId, targetId, maxDepth, minSimilarity) {
  // Build adjacency list
  const adjacency = {};
  const allContexts = new Set([sourceId, targetId]);

  // Get all contexts and their similarities
  const allResult = await db.query(
    `SELECT
       ce1.context_id as context1,
       ce2.context_id as context2,
       1 - (ce1.embedding <=> ce2.embedding) as similarity
     FROM context_embeddings ce1
     CROSS JOIN context_embeddings ce2
     WHERE ce1.context_id IN (
       SELECT context_id FROM context_layers
       WHERE user_id = $1 AND is_active = true
     )
     AND ce2.context_id IN (
       SELECT context_id FROM context_layers
       WHERE user_id = $1 AND is_active = true
     )
     AND ce1.context_id != ce2.context_id
     AND (1 - (ce1.embedding <=> ce2.embedding)) >= $2
     LIMIT 10000`,
    [userId, minSimilarity]
  );

  // Build adjacency list
  for (const row of allResult.rows) {
    const { context1, context2, similarity } = row;
    allContexts.add(context1);
    allContexts.add(context2);

    if (!adjacency[context1]) adjacency[context1] = [];
    if (!adjacency[context2]) adjacency[context2] = [];

    adjacency[context1].push({ id: context2, similarity: parseFloat(similarity) });
    adjacency[context2].push({ id: context1, similarity: parseFloat(similarity) });
  }

  // BFS to find paths
  const queue = [[sourceId]];
  const visited = new Set([sourceId]);
  const paths = [];

  while (queue.length > 0 && paths.length < 5) {
    const path = queue.shift();
    const current = path[path.length - 1];

    if (current === targetId) {
      paths.push(path);
      continue;
    }

    if (path.length >= maxDepth) continue;

    const neighbors = adjacency[current] || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor.id) || neighbor.id === targetId) {
        const newPath = [...path, neighbor.id];
        queue.push(newPath);

        if (neighbor.id !== targetId) {
          visited.add(neighbor.id);
        }
      }
    }
  }

  // Get context names for paths
  if (paths.length > 0) {
    const pathContextIds = new Set();
    paths.forEach(path => path.forEach(id => pathContextIds.add(id)));

    const namesResult = await db.query(
      `SELECT context_id, name
       FROM context_layers
       WHERE context_id = ANY($1::UUID[])`,
      [Array.from(pathContextIds)]
    );

    const nameMap = {};
    namesResult.rows.forEach(row => {
      nameMap[row.context_id] = row.name;
    });

    return paths.map(path => ({
      path: path.map(id => ({
        context_id: id,
        name: nameMap[id] || 'Unknown'
      })),
      length: path.length - 1
    }));
  }

  return [];
}

export default {
  generateGraph,
  findPaths,
  getNeighbors
};
