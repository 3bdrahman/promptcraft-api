/**
 * Unified Semantic Search Handler
 *
 * Provides a single endpoint for searching across all resource types
 * with semantic similarity. Designed for the command palette.
 *
 * @module handlers/search/unified
 */

import { db } from '../../utils/database.js';
import { getUserId } from '../../utils/auth.js';
import { success, error } from '../../utils/responses.js';
import { generateEmbedding } from '../../services/localEmbeddingService.js';

/**
 * POST /api/search/unified
 * Unified semantic search across all resource types
 *
 * Use this for command palettes and universal search features
 */
export async function unifiedSearch(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      query,
      resource_types = ['templates', 'contexts'], // Which types to search
      limit_per_type = 5, // Results per type
      min_similarity = 0.6, // Lower threshold for broader results
    } = req.body;

    if (!query || query.trim().length === 0) {
      return res.status(400).json(error('query is required'));
    }

    // Generate embedding for the query
    const startTime = Date.now();
    const { embedding } = await generateEmbedding(query);
    const embeddingTime = Date.now() - startTime;

    const results = {
      query,
      embedding_time_ms: embeddingTime,
      results: {},
    };

    // Search templates if requested
    if (resource_types.includes('templates')) {
      const templateResults = await db.query(
        `SELECT
           template_id,
           name,
           description,
           category,
           tags,
           similarity,
           likes_count,
           usage_count,
           visibility
         FROM find_similar_templates(
           $1::vector(384),
           $2::UUID,
           $3::INT,
           $4::DECIMAL,
           ARRAY[]::UUID[]
         )`,
        [`[${embedding.join(',')}]`, userId, limit_per_type, min_similarity]
      );

      results.results.templates = templateResults.rows.map(row => ({
        id: row.template_id,
        type: 'template',
        name: row.name,
        description: row.description,
        category: row.category,
        tags: row.tags || [],
        similarity: parseFloat(row.similarity),
        metadata: {
          likes_count: row.likes_count,
          usage_count: row.usage_count,
          visibility: row.visibility,
        },
      }));
    }

    // Search contexts if requested
    if (resource_types.includes('contexts')) {
      const contextResults = await db.query(
        `SELECT
           context_id,
           name,
           description,
           layer_type,
           tags,
           similarity,
           visibility
         FROM find_similar_contexts(
           $1::vector(384),
           $2::UUID,
           $3::INT,
           $4::DECIMAL,
           ARRAY[]::UUID[]
         )`,
        [`[${embedding.join(',')}]`, userId, limit_per_type, min_similarity]
      );

      results.results.contexts = contextResults.rows.map(row => ({
        id: row.context_id,
        type: 'context',
        name: row.name,
        description: row.description,
        layer_type: row.layer_type,
        tags: row.tags || [],
        similarity: parseFloat(row.similarity),
        metadata: {
          visibility: row.visibility,
        },
      }));
    }

    // Search saved compositions if requested
    if (resource_types.includes('compositions')) {
      // TODO: Implement when compositions are stored
      results.results.compositions = [];
    }

    // Calculate total results
    results.total_results = Object.values(results.results)
      .reduce((sum, arr) => sum + arr.length, 0);

    // Total query time
    results.total_time_ms = Date.now() - startTime;

    return res.json(success(results));
  } catch (err) {
    console.error('Unified search error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/search/quick
 * Quick search with minimal results (optimized for command palette)
 *
 * Faster than unified search - only returns top 3 per category
 */
export async function quickSearch(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { q: query } = req.query;

    if (!query || query.trim().length === 0) {
      return res.status(400).json(error('q parameter is required'));
    }

    // For very short queries, skip semantic search
    if (query.length < 3) {
      return res.json(success({
        query,
        results: { templates: [], contexts: [] },
        total_results: 0,
        method: 'skipped',
      }));
    }

    // Generate embedding
    const { embedding } = await generateEmbedding(query);

    // Quick parallel search
    const [templateResults, contextResults] = await Promise.all([
      db.query(
        `SELECT
           template_id,
           name,
           description,
           category,
           similarity
         FROM find_similar_templates(
           $1::vector(384),
           $2::UUID,
           3, -- Top 3 only
           0.5, -- Lower threshold for command palette
           ARRAY[]::UUID[]
         )`,
        [`[${embedding.join(',')}]`, userId]
      ),
      db.query(
        `SELECT
           context_id,
           name,
           description,
           layer_type,
           similarity
         FROM find_similar_contexts(
           $1::vector(384),
           $2::UUID,
           3, -- Top 3 only
           0.5,
           ARRAY[]::UUID[]
         )`,
        [`[${embedding.join(',')}]`, userId]
      ),
    ]);

    const results = {
      query,
      results: {
        templates: templateResults.rows.map(row => ({
          id: row.template_id,
          type: 'template',
          name: row.name,
          description: row.description,
          category: row.category,
          similarity: parseFloat(row.similarity),
        })),
        contexts: contextResults.rows.map(row => ({
          id: row.context_id,
          type: 'context',
          name: row.name,
          description: row.description,
          layer_type: row.layer_type,
          similarity: parseFloat(row.similarity),
        })),
      },
      total_results:
        templateResults.rows.length + contextResults.rows.length,
      method: 'semantic',
    };

    return res.json(success(results));
  } catch (err) {
    console.error('Quick search error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

export default {
  unifiedSearch,
  quickSearch,
};
