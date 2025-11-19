/**
 * Templates API - Updated for Enterprise Schema
 * Uses universal entity table with entity_type = 'template'
 * Supports temporal versioning and event sourcing
 */

import {
  db,
  ensureTenant,
  createEntity,
  updateEntity,
  deleteEntity,
  getCurrentEntity,
  trackUsage,
  logEvent
} from '../../utils/database.js';
import { getUserId, requireAuth } from '../../middleware/auth/index.js';
import { success, error, paginated, handleCors } from '../../utils/responses.js';
import { TEMPLATE_CATEGORIES } from '@promptcraft/shared/constants';
import {
  getCategoryInfo,
  getCategoriesByGrandparent,
  getCategoriesByParent,
  getFilteredCategories,
  isValidCategory
} from '../../utils/category-helpers.js';
import {
  semanticTemplateSearch,
  findSimilarTemplates,
  queueTemplateEmbeddingGeneration
} from './templates/search.js';

export default async function handler(req, res) {
  // Handle CORS
  if (handleCors(req, res)) return;

  const { method, url } = req;

  // Parse URL and query parameters properly
  const urlObj = new URL(url, `https://${req.headers.host || 'localhost'}`);
  const urlWithoutQuery = urlObj.pathname;
  const query = Object.fromEntries(urlObj.searchParams);

  // Merge with req.query if it exists (some environments provide it pre-parsed)
  req.query = { ...query, ...req.query };

  // Handle both direct Vercel calls and Express router calls
  // Express strips the /templates prefix, so we need to check both
  let pathParts = urlWithoutQuery.split('/').filter(Boolean);

  // If using Express router, pathParts won't include 'templates'
  // If direct call (Vercel), pathParts[0] will be 'templates'
  if (pathParts[0] === 'templates') {
    pathParts = pathParts.slice(1); // Remove 'templates' prefix
  }

  try {
    // GET /templates/schema - Debug: Show database schema
    if (method === 'GET' && pathParts[0] === 'schema') {
      return await getTableSchema(req, res);
    }

    // GET /templates - List all public templates
    if (method === 'GET' && pathParts.length === 0) {
      return await getTemplates(req, res);
    }

    // GET /templates/favorites - Get user's favorite templates
    if (method === 'GET' && pathParts[0] === 'favorites') {
      return await getUserFavorites(req, res);
    }

    // GET /templates/my-templates - Get user's private templates
    if (method === 'GET' && pathParts[0] === 'my-templates') {
      return await getUserTemplates(req, res);
    }

    // GET /templates/team/:teamId - Get team's shared templates
    if (method === 'GET' && pathParts[0] === 'team' && pathParts.length === 2) {
      return await getTeamTemplates(req, res, pathParts[0]);
    }

    // POST /templates/:id/share - Share template with team
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'share') {
      return await shareTemplate(req, res, pathParts[0]);
    }

    // POST /templates/:id/unshare - Unshare template (make private)
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'unshare') {
      return await unshareTemplate(req, res, pathParts[0]);
    }

    // GET /templates/:id/versions - Get version history
    if (method === 'GET' && pathParts.length === 2 && pathParts[1] === 'versions') {
      return await getTemplateVersions(req, res, pathParts[0]);
    }

    // GET /templates/:id/versions/:versionId - Get specific version
    if (method === 'GET' && pathParts.length === 3 && pathParts[1] === 'versions') {
      return await getTemplateVersion(req, res, pathParts[0], pathParts[2]);
    }

    // POST /templates/:id/revert/:versionId - Revert to version
    if (method === 'POST' && pathParts.length === 3 && pathParts[1] === 'revert') {
      return await revertTemplateVersion(req, res, pathParts[0], pathParts[2]);
    }

    // POST /templates/:id/versions - Create manual version snapshot
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'versions') {
      return await createManualTemplateVersion(req, res, pathParts[0]);
    }

    // GET /templates/:id/dependencies - Get template dependencies
    if (method === 'GET' && pathParts.length === 2 && pathParts[1] === 'dependencies') {
      return await getTemplateDependencies(req, res, pathParts[0]);
    }

    // GET /templates/:id/dependents - Get what depends on this template
    if (method === 'GET' && pathParts.length === 2 && pathParts[1] === 'dependents') {
      return await getTemplateDependents(req, res, pathParts[0]);
    }

    // POST /templates/search - Semantic search for templates
    if (method === 'POST' && pathParts.length === 1 && pathParts[0] === 'search') {
      return await semanticTemplateSearch(req, res);
    }

    // GET /templates/:id/similar - Find similar templates
    if (method === 'GET' && pathParts.length === 2 && pathParts[1] === 'similar') {
      return await findSimilarTemplates(req, res, pathParts[0]);
    }

    // POST /templates/:id/generate-embedding - Queue template for embedding generation
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'generate-embedding') {
      return await queueTemplateEmbeddingGeneration(req, res, pathParts[0]);
    }

    // GET /templates/:id/suggested-contexts - Get suggested contexts for template
    if (method === 'GET' && pathParts.length === 2 && pathParts[1] === 'suggested-contexts') {
      return await getSuggestedContexts(req, res, pathParts[0]);
    }

    // POST /templates/:id/clone - Clone template
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'clone') {
      return await cloneTemplate(req, res, pathParts[0]);
    }

    // POST /templates/:id/track-usage - Track template usage with context
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'track-usage') {
      return await trackTemplateUsage(req, res, pathParts[0]);
    }

    // POST /templates/:id/render - Render template with variable substitution
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'render') {
      return await renderTemplate(req, res, pathParts[0]);
    }

    // GET /templates/:id - Get single template
    if (method === 'GET' && pathParts.length === 1 && !['favorites', 'my-templates', 'schema', 'team'].includes(pathParts[0])) {
      return await getTemplate(req, res, pathParts[0]);
    }

    // POST /templates/:id/favorite - Toggle favorite status
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'favorite') {
      return await toggleFavorite(req, res, pathParts[0]);
    }

    // POST /templates - Create new template
    if (method === 'POST' && pathParts.length === 0) {
      return await createTemplate(req, res);
    }

    // PUT /templates/:id - Update template
    if (method === 'PUT' && pathParts.length === 1) {
      return await updateTemplate(req, res, pathParts[0]);
    }

    // DELETE /templates/:id - Delete template
    if (method === 'DELETE' && pathParts.length === 1) {
      return await deleteTemplate(req, res, pathParts[0]);
    }

    return res.status(404).json(error('Endpoint not found', 404));

  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json(error(`Internal server error: ${err.message}`, 500));
  }
}

// Get all public templates with optional filtering
async function getTemplates(req, res) {
  const {
    category,
    grandparent,
    parent,
    categories,
    grandparents,
    parents,
    search,
    tags,
    limit = 25,
    offset = 0,
    sortBy = 'created_at',
    excludeIds
  } = req.query;
  const userId = await getUserId(req);

  let query = `
    SELECT e.*,
           u.username,
           COALESCE(fc.favorite_count, 0) as favorite_count,
           ${userId ? `CASE WHEN uf.user_id IS NOT NULL THEN true ELSE false END as user_favorited` : 'false as user_favorited'}
    FROM entity e
    LEFT JOIN "user" u ON e.owner_id = u.id
    LEFT JOIN (
      SELECT entity_id, COUNT(*)::int as favorite_count
      FROM favorite
      GROUP BY entity_id
    ) fc ON fc.entity_id = e.id
    ${userId ? `LEFT JOIN favorite uf ON uf.entity_id = e.id AND uf.user_id = $1` : ''}
    WHERE e.entity_type = 'template'
      AND e.visibility = 'public'
      AND e.valid_to IS NULL
      AND e.deleted_at IS NULL
  `;

  const params = [];
  let paramCount = 0;

  if (userId) {
    paramCount++;
    params.push(userId);
  }

  // Hierarchical category filtering using new helper functions
  const targetCategories = getFilteredCategories({ grandparent, parent, category });

  if (targetCategories.length > 0) {
    paramCount++;
    query += ` AND e.metadata->>'category' = ANY($${paramCount})`;
    params.push(targetCategories);
  }

  // Support for multiple categories (backwards compatibility)
  if (categories) {
    let categoriesList;
    try {
      categoriesList = Array.isArray(categories) ? categories : JSON.parse(categories);
    } catch {
      categoriesList = typeof categories === 'string' ? categories.split(',').map(c => c.trim()) : [];
    }
    if (categoriesList.length > 0) {
      paramCount++;
      query += ` AND e.metadata->>'category' = ANY($${paramCount})`;
      params.push(categoriesList);
    }
  }

  // Search filtering - enhanced to include tags and creator
  if (search) {
    paramCount++;
    query += ` AND (
      e.title ILIKE $${paramCount} OR
      e.description ILIKE $${paramCount} OR
      u.username ILIKE $${paramCount} OR
      EXISTS(SELECT 1 FROM unnest(e.tags) as tag WHERE tag ILIKE $${paramCount})
    )`;
    params.push(`%${search}%`);
  }

  // Tag filtering - support multiple tags with OR logic
  if (tags) {
    let tagsList;
    try {
      tagsList = Array.isArray(tags) ? tags : JSON.parse(tags);
    } catch {
      tagsList = typeof tags === 'string' ? tags.split(',').map(t => t.trim()) : [];
    }

    if (tagsList.length > 0) {
      const tagConditions = tagsList.map(tag => {
        paramCount++;
        params.push(`%${tag}%`);
        return `template_tag ILIKE $${paramCount}`;
      }).join(' OR ');

      query += ` AND EXISTS(SELECT 1 FROM unnest(e.tags) as template_tag WHERE ${tagConditions})`;
    }
  }

  // Exclude already-loaded template IDs for additive filtering
  if (excludeIds) {
    let excludeIdsList;
    try {
      excludeIdsList = Array.isArray(excludeIds) ? excludeIds : JSON.parse(excludeIds);
    } catch {
      excludeIdsList = typeof excludeIds === 'string' ? excludeIds.split(',').map(id => id.trim()) : [];
    }

    if (excludeIdsList.length > 0) {
      paramCount++;
      query += ` AND e.id != ALL($${paramCount})`;
      params.push(excludeIdsList);
    }
  }

  // Sorting
  let orderClause = 'ORDER BY ';
  switch (sortBy) {
    case 'alphabetical':
      orderClause += 'e.title ASC';
      break;
    case 'rating':
      orderClause += 'favorite_count DESC, e.created_at DESC';
      break;
    case 'downloads':
    case 'usage':
      orderClause += 'favorite_count DESC, e.created_at DESC';
      break;
    case 'recent':
      orderClause += 'e.updated_at DESC';
      break;
    case 'relevance':
      if (search) {
        orderClause += `
          (CASE
            WHEN e.title ILIKE $${params.findIndex(p => p === `%${search}%`) + 1} THEN 1
            WHEN e.description ILIKE $${params.findIndex(p => p === `%${search}%`) + 1} THEN 2
            ELSE 3
          END) ASC, favorite_count DESC, e.created_at DESC`;
      } else {
        orderClause += 'favorite_count DESC, e.created_at DESC';
      }
      break;
    default:
      orderClause += 'e.created_at DESC';
  }

  query += ` ${orderClause}`;

  paramCount++;
  query += ` LIMIT $${paramCount}`;
  params.push(parseInt(limit));

  paramCount++;
  query += ` OFFSET $${paramCount}`;
  params.push(parseInt(offset));

  // Get total count for pagination
  let countQuery = `
    SELECT COUNT(*) as total
    FROM entity e
    WHERE e.entity_type = 'template'
      AND e.visibility = 'public'
      AND e.valid_to IS NULL
      AND e.deleted_at IS NULL
  `;
  const countParams = [];
  let countParamCount = 0;

  // Apply the same filters to count query
  if (targetCategories.length > 0) {
    countParamCount++;
    countQuery += ` AND e.metadata->>'category' = ANY($${countParamCount})`;
    countParams.push(targetCategories);
  }

  if (categories) {
    let categoriesList;
    try {
      categoriesList = Array.isArray(categories) ? categories : JSON.parse(categories);
    } catch {
      categoriesList = typeof categories === 'string' ? categories.split(',').map(c => c.trim()) : [];
    }
    if (categoriesList.length > 0) {
      countParamCount++;
      countQuery += ` AND e.metadata->>'category' = ANY($${countParamCount})`;
      countParams.push(categoriesList);
    }
  }

  if (search) {
    countParamCount++;
    countQuery += ` AND (
      e.title ILIKE $${countParamCount} OR
      e.description ILIKE $${countParamCount} OR
      EXISTS(
        SELECT 1 FROM "user" u
        WHERE u.id = e.owner_id AND u.username ILIKE $${countParamCount}
      ) OR
      EXISTS(SELECT 1 FROM unnest(e.tags) as tag WHERE tag ILIKE $${countParamCount})
    )`;
    countParams.push(`%${search}%`);
  }

  if (tags) {
    let tagsList;
    try {
      tagsList = Array.isArray(tags) ? tags : JSON.parse(tags);
    } catch {
      tagsList = typeof tags === 'string' ? tags.split(',').map(t => t.trim()) : [];
    }

    if (tagsList.length > 0) {
      const tagConditions = tagsList.map(tag => {
        countParamCount++;
        countParams.push(`%${tag}%`);
        return `template_tag ILIKE $${countParamCount}`;
      }).join(' OR ');

      countQuery += ` AND EXISTS(SELECT 1 FROM unnest(e.tags) as template_tag WHERE ${tagConditions})`;
    }
  }

  if (excludeIds) {
    let excludeIdsList;
    try {
      excludeIdsList = Array.isArray(excludeIds) ? excludeIds : JSON.parse(excludeIds);
    } catch {
      excludeIdsList = typeof excludeIds === 'string' ? excludeIds.split(',').map(id => id.trim()) : [];
    }

    if (excludeIdsList.length > 0) {
      countParamCount++;
      countQuery += ` AND e.id != ALL($${countParamCount})`;
      countParams.push(excludeIdsList);
    }
  }

  console.log(`🔍 [API] Executing query with ${params.length} parameters:`, query);
  console.log(`🔍 [API] Parameters:`, params);

  const result = await db.query(query, params);
  const countResult = await db.query(countQuery, countParams);
  const totalCount = parseInt(countResult.rows[0].total);

  console.log(`🔍 [API] Query returned ${result.rows.length} templates, total count: ${totalCount}`);

  const templates = result.rows.map(row => {
    const favoriteCount = parseInt(row.favorite_count) || 0;
    const template = mapEntityToTemplate(row, favoriteCount, userId ? row.user_favorited : false);
    return enrichWithHierarchy(template);
  });

  return res.json({
    templates,
    pagination: {
      totalCount,
      limit: parseInt(limit),
      offset: parseInt(offset),
      hasMore: parseInt(offset) + parseInt(limit) < totalCount,
      hasNextPage: parseInt(offset) + parseInt(limit) < totalCount,
      page: Math.floor(parseInt(offset) / parseInt(limit)) + 1,
      totalPages: Math.ceil(totalCount / parseInt(limit))
    }
  });
}

// Get user's own templates (both public and private)
async function getUserTemplates(req, res) {
  const userId = await getUserId(req);

  console.log('🔍 DEBUG getUserTemplates - userId:', userId);

  if (!userId) {
    console.log('❌ DEBUG getUserTemplates - No userId, authentication failed');
    return res.status(401).json(error('Authentication required', 401));
  }

  try {
    const { limit = 50, offset = 0 } = req.query;

    // Get username for the authenticated user
    const userResult = await db.query('SELECT username FROM "user" WHERE id = $1', [userId]);
    console.log('🔍 DEBUG getUserTemplates - userResult:', userResult.rows);

    if (userResult.rows.length === 0) {
      console.log('❌ DEBUG getUserTemplates - User not found in database');
      return res.status(404).json(error('User not found', 404));
    }

    const username = userResult.rows[0].username;
    console.log('🔍 DEBUG getUserTemplates - username:', username);

    // Get all templates created by this user (both public and private)
    const query = `
      SELECT e.*,
             u.username,
             COALESCE(uf.favorite_count, 0) as favorite_count,
             false as user_favorited
      FROM entity e
      JOIN "user" u ON e.owner_id = u.id
      LEFT JOIN (
        SELECT entity_id, COUNT(*)::int as favorite_count
        FROM favorite
        GROUP BY entity_id
      ) uf ON uf.entity_id = e.id
      WHERE e.owner_id = $1
        AND e.entity_type = 'template'
        AND e.valid_to IS NULL
        AND e.deleted_at IS NULL
      ORDER BY e.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await db.query(query, [userId, parseInt(limit), parseInt(offset)]);

    console.log('🔍 DEBUG getUserTemplates - query result:', {
      rowCount: result.rows.length,
      templates: result.rows.map(r => ({ id: r.id, title: r.title, username: r.username, visibility: r.visibility }))
    });

    const templates = result.rows.map(row => {
      const favoriteCount = parseInt(row.favorite_count) || 0;
      const template = mapEntityToTemplate(row, favoriteCount, false);
      return enrichWithHierarchy(template);
    });

    return res.json({
      templates,
      total: templates.length,
      public_count: templates.filter(t => t.is_public).length,
      private_count: templates.filter(t => !t.is_public).length
    });

  } catch (err) {
    console.error('Error fetching user templates:', err);
    return res.status(500).json(error('Failed to fetch user templates', 500));
  }
}

// Get single template by ID
async function getTemplate(req, res, templateId) {
  const userId = await getUserId(req);

  console.log('🔍 DEBUG getTemplate - templateId:', templateId);
  console.log('🔍 DEBUG getTemplate - userId:', userId);

  let query, params;

  if (userId) {
    // If user is authenticated, allow access to public templates OR their own private templates
    query = `
      SELECT e.*,
             u.username,
             (SELECT COUNT(*) FROM favorite f WHERE f.entity_id = e.id) as favorite_count,
             EXISTS(SELECT 1 FROM favorite f WHERE f.entity_id = e.id AND f.user_id = $2) as user_favorited
      FROM entity e
      LEFT JOIN "user" u ON e.owner_id = u.id
      WHERE e.id = $1
        AND e.entity_type = 'template'
        AND (e.visibility = 'public' OR e.owner_id = $2)
        AND e.valid_to IS NULL
        AND e.deleted_at IS NULL
    `;
    params = [templateId, userId];
  } else {
    // If user is not authenticated, only allow public templates
    console.log('🔍 DEBUG getTemplate - No userId, using public-only query');
    query = `
      SELECT e.*,
             u.username,
             (SELECT COUNT(*) FROM favorite f WHERE f.entity_id = e.id) as favorite_count,
             false as user_favorited
      FROM entity e
      LEFT JOIN "user" u ON e.owner_id = u.id
      WHERE e.id = $1
        AND e.entity_type = 'template'
        AND e.visibility = 'public'
        AND e.valid_to IS NULL
        AND e.deleted_at IS NULL
    `;
    params = [templateId];
  }

  console.log('🔍 DEBUG getTemplate - Query:', query);
  console.log('🔍 DEBUG getTemplate - Params:', params);

  const result = await db.query(query, params);

  console.log('🔍 DEBUG getTemplate - Query result:', {
    rowCount: result.rows.length,
    template: result.rows[0] ? {
      id: result.rows[0].id,
      title: result.rows[0].title,
      username: result.rows[0].username,
      visibility: result.rows[0].visibility
    } : null
  });

  if (result.rows.length === 0) {
    console.log('❌ DEBUG getTemplate - Template not found or access denied');
    return res.status(404).json(error('Template not found', 404));
  }

  const row = result.rows[0];
  const favoriteCount = parseInt(row.favorite_count) || 0;

  const template = mapEntityToTemplate(row, favoriteCount, row.user_favorited);
  template.creator = row.username ? {
    username: row.username,
    displayName: row.username,
    avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(row.username)}&background=6366f1&color=fff`
  } : null;

  // Use consistent wrapper format like other endpoints
  const finalTemplate = enrichWithHierarchy(template);
  return res.json({
    template: finalTemplate,
    success: true
  });
}

// Get user's favorite templates
async function getUserFavorites(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const { page = 1, limit = 25 } = req.query;
  const offset = (page - 1) * limit;

  const query = `
    SELECT e.*,
           u.username,
           f.created_at as favorited_at,
           (SELECT COUNT(*) FROM favorite f2 WHERE f2.entity_id = e.id) as favorite_count
    FROM favorite f
    JOIN entity e ON f.entity_id = e.id
    LEFT JOIN "user" u ON e.owner_id = u.id
    WHERE f.user_id = $1
      AND e.entity_type = 'template'
      AND e.visibility = 'public'
      AND e.valid_to IS NULL
      AND e.deleted_at IS NULL
    ORDER BY f.created_at DESC
    LIMIT $2 OFFSET $3
  `;

  const result = await db.query(query, [user.id, parseInt(limit), parseInt(offset)]);

  const countQuery = `
    SELECT COUNT(*)
    FROM favorite f
    JOIN entity e ON f.entity_id = e.id
    WHERE f.user_id = $1
      AND e.entity_type = 'template'
      AND e.visibility = 'public'
      AND e.valid_to IS NULL
      AND e.deleted_at IS NULL
  `;
  const countResult = await db.query(countQuery, [user.id]);
  const totalCount = parseInt(countResult.rows[0].count);

  const favorites = result.rows.map(row => {
    const favoriteCount = parseInt(row.favorite_count) || 0;
    const template = mapEntityToTemplate(row, favoriteCount, true);
    template.favorited_at = row.favorited_at;
    return enrichWithHierarchy(template);
  });

  return res.json({
    templates: favorites,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      hasNext: parseInt(page) < Math.ceil(totalCount / limit),
      hasPrev: parseInt(page) > 1
    }
  });
}

// Toggle favorite status for a template
async function toggleFavorite(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  console.log('🔄 API - Toggle favorite request:', {
    userId: user.id,
    templateId,
    userEmail: user.email
  });

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(templateId)) {
    console.log('❌ API - Invalid template ID format:', templateId);
    return res.status(400).json(error('Invalid template ID format', 400));
  }

  // Check if template exists and is public
  const templateResult = await db.query(
    `SELECT id FROM entity
     WHERE id = $1
       AND entity_type = 'template'
       AND visibility = 'public'
       AND valid_to IS NULL
       AND deleted_at IS NULL`,
    [templateId]
  );

  console.log('📊 API - Template query result:', {
    found: templateResult.rows.length > 0,
    templateId,
    rowCount: templateResult.rows.length
  });

  if (templateResult.rows.length === 0) {
    return res.status(404).json(error('Template not found', 404));
  }

  // Check if already favorited
  const existingFavorite = await db.query(
    'SELECT id FROM favorite WHERE user_id = $1 AND entity_id = $2',
    [user.id, templateId]
  );

  console.log('❤️ API - Existing favorite check:', {
    userId: user.id,
    templateId,
    alreadyFavorited: existingFavorite.rows.length > 0
  });

  let isFavorited;
  const tenantId = await ensureTenant(user.id);

  if (existingFavorite.rows.length > 0) {
    // Remove from favorites
    console.log('➖ API - Removing from favorites');
    await db.query('DELETE FROM favorite WHERE user_id = $1 AND entity_id = $2', [user.id, templateId]);
    isFavorited = false;

    // Log event
    await logEvent({
      tenantId,
      eventType: 'template.unfavorited',
      aggregateType: 'entity',
      aggregateId: templateId,
      actorId: user.id,
      payload: { entityType: 'template' }
    });
  } else {
    // Add to favorites
    console.log('➕ API - Adding to favorites');
    await db.query('INSERT INTO favorite (user_id, entity_id) VALUES ($1, $2)', [user.id, templateId]);
    isFavorited = true;

    // Log event
    await logEvent({
      tenantId,
      eventType: 'template.favorited',
      aggregateType: 'entity',
      aggregateId: templateId,
      actorId: user.id,
      payload: { entityType: 'template' }
    });
  }

  // Get updated favorite count
  const countResult = await db.query('SELECT COUNT(*) as count FROM favorite WHERE entity_id = $1', [templateId]);
  const favoriteCount = parseInt(countResult.rows[0].count);

  return res.json(success({
    templateId,
    isFavorited,
    favoriteCount,
    timestamp: new Date().toISOString()
  }, isFavorited ? 'Added to favorites' : 'Removed from favorites'));
}

// Create new template
async function createTemplate(req, res) {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    console.log('🔍 API DEBUG: Received request body:', req.body);
    console.log('🔍 API DEBUG: Request headers:', req.headers);

    // Handle different body formats
    let bodyData = req.body;
    if (typeof req.body === 'string') {
      try {
        bodyData = JSON.parse(req.body);
        console.log('🔍 API DEBUG: Parsed body from string:', bodyData);
      } catch (e) {
        console.error('🔍 API DEBUG: Failed to parse body as JSON:', e);
        return res.status(400).json(error('Invalid JSON in request body', 400));
      }
    }

    const { name, description, content, variables, category, tags, is_public } = bodyData;

    console.log('🔍 API DEBUG: Extracted fields:', { name, description, content, variables, category, tags, is_public });

    // Tags should now be simple arrays throughout the system
    const normalizedTags = Array.isArray(tags) ? tags : [];

    console.log('🔍 API DEBUG: Normalized tags:', normalizedTags);

    // Name and content are required, description is optional
    if (!name || !content) {
      return res.status(400).json(error('Name and content are required', 400));
    }

    // Ensure category defaults to 'general'
    const validCategory = category || 'general';

    // Variables should be array
    const normalizedVariables = Array.isArray(variables) ? variables : [];

    // Ensure description defaults to empty string if not provided
    const normalizedDescription = description || '';

    // Ensure tenant
    const tenantId = await ensureTenant(user.id);

    // Create entity
    const entity = await createEntity({
      tenantId,
      ownerId: user.id,
      entityType: 'template',
      title: name,
      description: normalizedDescription,
      content: { text: content }, // Store as JSONB
      tags: normalizedTags,
      metadata: {
        category: validCategory,
        variables: normalizedVariables,
        is_public: is_public || false
      },
      visibility: (is_public || false) ? 'public' : 'private',
      status: 'published'
    });

    // Log event
    await logEvent({
      tenantId,
      eventType: 'entity.created',
      aggregateType: 'entity',
      aggregateId: entity.id,
      actorId: user.id,
      payload: { entityType: 'template', category: validCategory }
    });

    console.log('🔍 API DEBUG: Raw entity result:', entity);
    console.log('🔍 API DEBUG: User object:', user);

    // Return the template with consistent structure
    const template = mapEntityToTemplate(entity, 0, false);
    template.username = user.username;
    template.userInteractions = {
      isFavorited: false,
      isOwner: true
    };
    template.engagement = {
      favorites: 0,
      downloads: 0,
      ratings: { average: 0, count: 0 }
    };

    console.log('🔍 API DEBUG: Mapped template before enrichment:', template);

    // Enrich with hierarchical category structure
    const enrichedTemplate = enrichWithHierarchy(template);

    console.log('🔍 API DEBUG: Enriched template after enrichment:', enrichedTemplate);

    return res.status(201).json(success(enrichedTemplate, 'Template created successfully'));

  } catch (err) {
    console.error('❌ CREATE_TEMPLATE ERROR:', err);
    return res.status(500).json(error('Failed to create template', 500));
  }
}

// Update existing template
async function updateTemplate(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(templateId)) {
    return res.status(400).json(error('Invalid template ID format', 400));
  }

  // Check if template exists and user is the creator
  const current = await getCurrentEntity(templateId);
  if (!current || current.owner_id !== user.id || current.entity_type !== 'template') {
    return res.status(404).json(error('Template not found', 404));
  }

  const { name, description, content, variables, category, tags, is_public } = req.body;

  // Name and content are required, description is optional
  if (!name || !content) {
    return res.status(400).json(error('Name and content are required', 400));
  }

  // Ensure category defaults to 'general'
  const validCategory = category || 'general';

  // Tags should now be simple arrays
  const normalizedTags = Array.isArray(tags) ? tags : [];

  // Variables should be array
  const normalizedVariables = Array.isArray(variables) ? variables : [];

  // Ensure description defaults to empty string if not provided
  const normalizedDescription = description || '';

  // Build updates object
  const updates = {
    title: name,
    description: normalizedDescription,
    content: { text: content },
    tags: normalizedTags,
    metadata: {
      ...current.metadata,
      category: validCategory,
      variables: normalizedVariables,
      is_public: is_public || false
    },
    visibility: (is_public || false) ? 'public' : 'private'
  };

  // Update entity (creates new version)
  const updated = await updateEntity(templateId, updates, user.id);

  // Log event
  const tenantId = await ensureTenant(user.id);
  await logEvent({
    tenantId,
    eventType: 'entity.updated',
    aggregateType: 'entity',
    aggregateId: templateId,
    actorId: user.id,
    payload: { entityType: 'template', category: validCategory }
  });

  // Map to old format
  const template = mapEntityToTemplate(updated, 0, false);

  return res.json(success(enrichWithHierarchy(template), 'Template updated successfully'));
}

// Delete template (with cascading cleanup)
async function deleteTemplate(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(templateId)) {
    return res.status(400).json(error('Invalid template ID format', 400));
  }

  // Check if template exists and user is the creator
  const current = await getCurrentEntity(templateId);
  if (!current || current.owner_id !== user.id || current.entity_type !== 'template') {
    return res.status(404).json(error('Template not found', 404));
  }

  // Delete entity (soft delete)
  await deleteEntity(templateId, user.id);

  // Log event
  const tenantId = await ensureTenant(user.id);
  await logEvent({
    tenantId,
    eventType: 'entity.deleted',
    aggregateType: 'entity',
    aggregateId: templateId,
    actorId: user.id,
    payload: { entityType: 'template', title: current.title }
  });

  return res.json(success({
    id: templateId,
    name: current.title
  }, 'Template deleted successfully'));
}

// Helper function to map entity to template format (backward compatibility)
function mapEntityToTemplate(entity, favoriteCount = 0, userFavorited = false) {
  const metadata = entity.metadata || {};
  const content = entity.content || {};

  return {
    id: entity.id,
    name: entity.title,
    description: entity.description,
    content: content.text || (typeof entity.content === 'string' ? entity.content : JSON.stringify(entity.content)),
    category: metadata.category || 'general',
    tags: entity.tags || [],
    variables: metadata.variables || [],
    is_public: metadata.is_public || entity.visibility === 'public',
    favorite_count: favoriteCount,
    created_at: entity.created_at,
    updated_at: entity.updated_at,
    username: entity.username,
    userInteractions: {
      isFavorited: userFavorited
    },
    engagement: {
      favorites: favoriteCount
    }
  };
}

// Helper function to map flat category to hierarchical structure
function enrichWithHierarchy(template) {
  if (!template.category) return template;

  let hierarchyInfo = null;

  // Search through category hierarchy
  TEMPLATE_CATEGORIES.forEach(grandparent => {
    grandparent.children.forEach(parent => {
      if (parent.children) {
        parent.children.forEach(category => {
          if (category.id === template.category) {
            hierarchyInfo = {
              grandparent: grandparent.id,
              parent: parent.id,
              category: category.id
            };
          }
        });
      }
    });
  });

  return {
    ...template,
    grandparent: hierarchyInfo?.grandparent || '',
    parent: hierarchyInfo?.parent || '',
    category: hierarchyInfo?.category || template.category || ''
  };
}

// Get team templates
async function getTeamTemplates(req, res, teamId) {
  const userId = await getUserId(req);

  if (!userId) {
    return res.status(401).json(error('Authentication required', 401));
  }

  try {
    // Check if user has access to this team
    const accessCheck = await db.query(
      'SELECT user_has_team_access($1, $2) as has_access',
      [userId, teamId]
    );

    if (!accessCheck.rows[0].has_access) {
      return res.status(403).json(error('You do not have access to this team', 403));
    }

    // Get templates shared with this team
    const query = `
      SELECT e.*,
             u.username,
             COALESCE(fc.favorite_count, 0) as favorite_count,
             CASE WHEN f.user_id IS NOT NULL THEN true ELSE false END as user_favorited
      FROM entity e
      LEFT JOIN "user" u ON e.owner_id = u.id
      LEFT JOIN (
        SELECT entity_id, COUNT(*)::int as favorite_count
        FROM favorite
        GROUP BY entity_id
      ) fc ON fc.entity_id = e.id
      LEFT JOIN favorite f ON f.entity_id = e.id AND f.user_id = $1
      WHERE e.entity_type = 'template'
        AND e.metadata->>'team_id' = $2
        AND e.visibility = 'team'
        AND e.valid_to IS NULL
        AND e.deleted_at IS NULL
      ORDER BY e.updated_at DESC
    `;

    const result = await db.query(query, [userId, teamId]);

    const templates = result.rows.map(row => {
      const favoriteCount = parseInt(row.favorite_count) || 0;
      const template = mapEntityToTemplate(row, favoriteCount, row.user_favorited);
      template.team_id = teamId;
      template.visibility = 'team';
      template.userInteractions.isOwner = row.owner_id === userId;
      return enrichWithHierarchy(template);
    });

    return res.json({
      templates,
      team_id: teamId,
      count: templates.length
    });

  } catch (err) {
    console.error('Error fetching team templates:', err);
    return res.status(500).json(error('Failed to fetch team templates', 500));
  }
}

// Share template with team
async function shareTemplate(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const { team_id, visibility = 'team' } = req.body;

  if (!team_id) {
    return res.status(400).json(error('team_id is required', 400));
  }

  try {
    // Verify ownership
    const current = await getCurrentEntity(templateId);
    if (!current || current.owner_id !== user.id || current.entity_type !== 'template') {
      return res.status(404).json(error('Template not found', 404));
    }

    // Update entity to add team_id to metadata and set visibility
    const updates = {
      metadata: {
        ...current.metadata,
        team_id
      },
      visibility: 'team'
    };

    const updated = await updateEntity(templateId, updates, user.id);

    // Log event
    const tenantId = await ensureTenant(user.id);
    await logEvent({
      tenantId,
      eventType: 'template.shared',
      aggregateType: 'entity',
      aggregateId: templateId,
      actorId: user.id,
      payload: { entityType: 'template', team_id }
    });

    const template = mapEntityToTemplate(updated, 0, false);
    return res.json(success(
      enrichWithHierarchy(template),
      'Template shared with team successfully'
    ));

  } catch (err) {
    console.error('Error sharing template:', err);
    return res.status(500).json(error(err.message || 'Failed to share template', 500));
  }
}

// Unshare template (make private)
async function unshareTemplate(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    // Verify ownership
    const current = await getCurrentEntity(templateId);
    if (!current || current.owner_id !== user.id || current.entity_type !== 'template') {
      return res.status(404).json(error('Template not found', 404));
    }

    // Update entity to remove team_id and set visibility to private
    const metadata = { ...current.metadata };
    delete metadata.team_id;

    const updates = {
      metadata,
      visibility: 'private'
    };

    const updated = await updateEntity(templateId, updates, user.id);

    // Log event
    const tenantId = await ensureTenant(user.id);
    await logEvent({
      tenantId,
      eventType: 'template.unshared',
      aggregateType: 'entity',
      aggregateId: templateId,
      actorId: user.id,
      payload: { entityType: 'template' }
    });

    const template = mapEntityToTemplate(updated, 0, false);
    return res.json(success(
      enrichWithHierarchy(template),
      'Template is now private'
    ));

  } catch (err) {
    console.error('Error unsharing template:', err);
    return res.status(500).json(error(err.message || 'Failed to unshare template', 500));
  }
}

// Get template version history
async function getTemplateVersions(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    // Verify access
    const current = await getCurrentEntity(templateId);
    if (!current || current.entity_type !== 'template') {
      return res.status(404).json(error('Template not found', 404));
    }

    // Get version history using temporal query
    const versions = await db.query(
      'SELECT * FROM get_entity_history($1) ORDER BY version DESC LIMIT 50',
      [templateId]
    );

    return res.json(success({
      template_id: templateId,
      versions: versions.rows,
      total: versions.rows.length
    }));
  } catch (err) {
    console.error('Error fetching template versions:', err);
    return res.status(500).json(error('Failed to fetch version history', 500));
  }
}

// Get specific template version
async function getTemplateVersion(req, res, templateId, versionId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    // Get specific version
    const result = await db.query(
      `SELECT * FROM entity
       WHERE id = $1 AND version = $2`,
      [templateId, parseInt(versionId)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Version not found', 404));
    }

    const template = mapEntityToTemplate(result.rows[0], 0, false);
    return res.json(success({ version: template }));
  } catch (err) {
    console.error('Error fetching template version:', err);
    return res.status(500).json(error('Failed to fetch version', 500));
  }
}

// Revert template to specific version
async function revertTemplateVersion(req, res, templateId, versionId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    // Verify ownership
    const current = await getCurrentEntity(templateId);
    if (!current || current.owner_id !== user.id || current.entity_type !== 'template') {
      return res.status(404).json(error('Template not found', 404));
    }

    // Get the version to revert to
    const versionResult = await db.query(
      `SELECT * FROM entity WHERE id = $1 AND version = $2`,
      [templateId, parseInt(versionId)]
    );

    if (versionResult.rows.length === 0) {
      return res.status(404).json(error('Version not found', 404));
    }

    const oldVersion = versionResult.rows[0];

    // Create a new version with the old content
    const updates = {
      title: oldVersion.title,
      description: oldVersion.description,
      content: oldVersion.content,
      tags: oldVersion.tags,
      metadata: oldVersion.metadata,
      visibility: oldVersion.visibility
    };

    const updated = await updateEntity(templateId, updates, user.id);

    // Log event
    const tenantId = await ensureTenant(user.id);
    await logEvent({
      tenantId,
      eventType: 'template.reverted',
      aggregateType: 'entity',
      aggregateId: templateId,
      actorId: user.id,
      payload: { entityType: 'template', revertedToVersion: versionId }
    });

    return res.json(success({
      message: 'Template reverted successfully',
      template_id: templateId,
      reverted_to_version: versionId
    }));
  } catch (err) {
    console.error('Error reverting template:', err);
    return res.status(500).json(error(err.message || 'Failed to revert template', 500));
  }
}

// Create manual version snapshot
async function createManualTemplateVersion(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const { change_summary } = req.body;

  try {
    // Verify ownership
    const current = await getCurrentEntity(templateId);
    if (!current || current.owner_id !== user.id || current.entity_type !== 'template') {
      return res.status(404).json(error('Template not found', 404));
    }

    // Create a new version by updating with same content (triggers version creation)
    const updated = await updateEntity(templateId, {
      metadata: {
        ...current.metadata,
        change_summary: change_summary || 'Manual snapshot'
      }
    }, user.id);

    // Log event
    const tenantId = await ensureTenant(user.id);
    await logEvent({
      tenantId,
      eventType: 'template.version_created',
      aggregateType: 'entity',
      aggregateId: templateId,
      actorId: user.id,
      payload: { entityType: 'template', change_summary }
    });

    return res.json(success({
      message: 'Version created successfully',
      version_id: updated.version
    }));
  } catch (err) {
    console.error('Error creating template version:', err);
    return res.status(500).json(error('Failed to create version', 500));
  }
}

// Get template dependencies
async function getTemplateDependencies(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    // Verify access
    const current = await getCurrentEntity(templateId);
    if (!current || current.entity_type !== 'template') {
      return res.status(404).json(error('Template not found', 404));
    }

    // Get dependencies from relationship table
    const result = await db.query(
      `SELECT r.*, e.title as dependency_name, e.entity_type as dependency_type
       FROM relationship r
       JOIN entity e ON r.target_id = e.id
       WHERE r.source_id = $1
         AND r.relationship_type = 'depends_on'
         AND e.valid_to IS NULL
         AND e.deleted_at IS NULL`,
      [templateId]
    );

    return res.json(success({
      template_id: templateId,
      dependencies: result.rows
    }));
  } catch (err) {
    console.error('Error fetching template dependencies:', err);
    return res.status(500).json(error('Failed to fetch dependencies', 500));
  }
}

// Get what depends on this template
async function getTemplateDependents(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    // Verify access
    const current = await getCurrentEntity(templateId);
    if (!current || current.entity_type !== 'template') {
      return res.status(404).json(error('Template not found', 404));
    }

    // Get dependents from relationship table
    const result = await db.query(
      `SELECT r.*, e.title as dependent_name, e.entity_type as dependent_type
       FROM relationship r
       JOIN entity e ON r.source_id = e.id
       WHERE r.target_id = $1
         AND r.relationship_type = 'depends_on'
         AND e.valid_to IS NULL
         AND e.deleted_at IS NULL`,
      [templateId]
    );

    return res.json(success({
      template_id: templateId,
      dependents: result.rows
    }));
  } catch (err) {
    console.error('Error fetching template dependents:', err);
    return res.status(500).json(error('Failed to fetch dependents', 500));
  }
}

// Get suggested contexts based on usage patterns
async function getSuggestedContexts(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    // Verify access
    const current = await getCurrentEntity(templateId);
    if (!current || current.entity_type !== 'template') {
      return res.status(404).json(error('Template not found', 404));
    }

    // Get suggested contexts based on relationships
    const result = await db.query(
      `SELECT DISTINCT e.id, e.title, e.description, e.entity_type,
              COUNT(*) OVER (PARTITION BY e.id) as usage_count
       FROM relationship r
       JOIN entity e ON r.target_id = e.id
       WHERE r.source_id = $1
         AND e.entity_type = 'context'
         AND e.valid_to IS NULL
         AND e.deleted_at IS NULL
       ORDER BY usage_count DESC
       LIMIT 10`,
      [templateId]
    );

    return res.json(success({
      template_id: templateId,
      suggested_contexts: result.rows
    }));
  } catch (err) {
    console.error('Error fetching suggested contexts:', err);
    return res.status(500).json(error('Failed to fetch suggestions', 500));
  }
}

// Track template usage with context
async function trackTemplateUsage(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const { layer_id } = req.body;

  if (!layer_id) {
    return res.status(400).json(error('layer_id is required', 400));
  }

  try {
    // Verify template access
    const current = await getCurrentEntity(templateId);
    if (!current || current.entity_type !== 'template') {
      return res.status(404).json(error('Template not found', 404));
    }

    const tenantId = await ensureTenant(user.id);

    // Track usage
    await trackUsage({
      tenantId,
      userId: user.id,
      entityId: templateId,
      eventType: 'entity.used'
    });

    // Create relationship if layer_id provided
    if (layer_id) {
      await db.query(
        `INSERT INTO relationship (source_id, target_id, relationship_type, created_by)
         VALUES ($1, $2, 'uses', $3)
         ON CONFLICT DO NOTHING`,
        [templateId, layer_id, user.id]
      );
    }

    // Log event
    await logEvent({
      tenantId,
      eventType: 'template.used',
      aggregateType: 'entity',
      aggregateId: templateId,
      actorId: user.id,
      payload: { entityType: 'template', layer_id }
    });

    return res.json(success({
      message: 'Usage tracked successfully'
    }));
  } catch (err) {
    console.error('Error tracking template usage:', err);
    return res.status(500).json(error('Failed to track usage', 500));
  }
}

// Clone template (create a copy for current user)
async function cloneTemplate(req, res, templateId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const { name: customName } = req.body;

  try {
    // Get original template
    const original = await getCurrentEntity(templateId);

    if (!original || original.entity_type !== 'template') {
      return res.status(404).json(error('Template not found', 404));
    }

    // Create clone with new name
    const cloneName = customName || `${original.title} (Copy)`;

    const tenantId = await ensureTenant(user.id);

    const cloned = await createEntity({
      tenantId,
      ownerId: user.id,
      entityType: 'template',
      title: cloneName,
      description: original.description,
      content: original.content,
      tags: original.tags,
      metadata: {
        ...original.metadata,
        cloned_from: templateId
      },
      visibility: 'private',
      status: 'published'
    });

    // Log event
    await logEvent({
      tenantId,
      eventType: 'template.cloned',
      aggregateType: 'entity',
      aggregateId: cloned.id,
      actorId: user.id,
      payload: { entityType: 'template', cloned_from: templateId }
    });

    const template = mapEntityToTemplate(cloned, 0, false);

    return res.status(201).json(success({
      template: enrichWithHierarchy(template),
      message: 'Template cloned successfully'
    }));

  } catch (err) {
    console.error('Error cloning template:', err);
    return res.status(500).json(error('Failed to clone template', 500));
  }
}

/**
 * Render template with variable substitution
 * POST /api/templates/:id/render
 * Body: { variables: { var1: "value1", var2: "value2" } }
 * Returns: { rendered: "final prompt text", metadata: {...} }
 */
async function renderTemplate(req, res, templateId) {
  try {
    const userId = await getUserId(req);
    const { variables = {} } = req.body;

    // Validate input
    if (typeof variables !== 'object' || Array.isArray(variables)) {
      return res.status(400).json(error('Variables must be an object', 400));
    }

    // Get template
    const template = await getCurrentEntity(templateId);

    if (!template || template.entity_type !== 'template') {
      return res.status(404).json(error('Template not found', 404));
    }

    // Check access permissions
    if (template.visibility === 'private' && template.owner_id !== userId) {
      return res.status(403).json(error('Access denied', 403));
    }

    if (template.visibility === 'team') {
      const teamId = template.metadata?.team_id;
      if (teamId && userId) {
        const teamAccessResult = await db.query(
          `SELECT user_has_team_access($1, $2) as has_access`,
          [userId, teamId]
        );
        if (!teamAccessResult.rows[0]?.has_access) {
          return res.status(403).json(error('Access denied', 403));
        }
      } else {
        return res.status(403).json(error('Access denied', 403));
      }
    }

    // Extract content
    const content = template.content?.text || (typeof template.content === 'string' ? template.content : JSON.stringify(template.content));

    // Extract variables from template content
    const templateVars = extractTemplateVariables(content);

    // Check for required variables
    const missingVars = [];
    for (const varInfo of templateVars) {
      if (varInfo.required && !(varInfo.name in variables)) {
        missingVars.push(varInfo.name);
      }
    }

    if (missingVars.length > 0) {
      return res.status(400).json(error(
        `Missing required variables: ${missingVars.join(', ')}`,
        400,
        { missingVariables: missingVars, requiredVariables: templateVars.filter(v => v.required) }
      ));
    }

    // Substitute variables in template content
    let rendered = content;

    for (const [varName, varValue] of Object.entries(variables)) {
      // Support multiple variable formats:
      // {{varName}}
      // {{varName:type}}
      // {{varName:type:description}}
      const patterns = [
        new RegExp(`\\{\\{${escapeRegExp(varName)}\\}\\}`, 'g'),
        new RegExp(`\\{\\{${escapeRegExp(varName)}:[^:}]+\\}\\}`, 'g'),
        new RegExp(`\\{\\{${escapeRegExp(varName)}:[^:}]+:[^}]+\\}\\}`, 'g'),
      ];

      for (const pattern of patterns) {
        rendered = rendered.replace(pattern, String(varValue));
      }
    }

    // Track template usage
    if (userId) {
      const tenantId = await ensureTenant(userId);
      await trackUsage({
        tenantId,
        userId,
        entityId: templateId,
        eventType: 'entity.used'
      });

      await logEvent({
        tenantId,
        eventType: 'template.rendered',
        aggregateType: 'entity',
        aggregateId: templateId,
        actorId: userId,
        payload: { entityType: 'template', variables: Object.keys(variables) }
      });
    }

    // Calculate token count (rough estimate: 4 chars ≈ 1 token)
    const estimatedTokens = Math.ceil(rendered.length / 4);

    return res.json(success({
      rendered,
      template_id: templateId,
      template_name: template.title,
      metadata: {
        original_length: content.length,
        rendered_length: rendered.length,
        estimated_tokens: estimatedTokens,
        variables_used: Object.keys(variables),
        variables_required: templateVars.filter(v => v.required).map(v => v.name),
        variables_optional: templateVars.filter(v => !v.required).map(v => v.name)
      }
    }));

  } catch (err) {
    console.error('Error rendering template:', err);
    return res.status(500).json(error('Failed to render template', 500));
  }
}

/**
 * Extract variables from template content
 * Returns array of { name, type, description, required }
 */
function extractTemplateVariables(content) {
  if (!content) return [];

  const regex = /\{\{([^}]+)\}\}/g;
  const matches = [...content.matchAll(regex)];
  const variables = [];
  const seen = new Set();

  for (const match of matches) {
    const fullMatch = match[1].trim();
    const parts = fullMatch.split(':').map(p => p.trim());

    const name = parts[0];
    if (seen.has(name)) continue;

    seen.add(name);

    variables.push({
      name,
      type: parts[1] || 'text',
      description: parts[2] || '',
      required: true // Default to required unless explicitly optional
    });
  }

  return variables;
}

/**
 * Escape special regex characters
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Debug function to check database schema
async function getTableSchema(req, res) {
  try {
    const query = `
      SELECT column_name, data_type, character_maximum_length, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'entity'
      ORDER BY ordinal_position;
    `;

    const result = await db.query(query);

    return res.json({
      table: 'entity',
      columns: result.rows
    });

  } catch (error) {
    console.error('Schema query error:', error);
    return res.status(500).json(error('Failed to get schema', 500));
  }
}
