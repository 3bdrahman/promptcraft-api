import { db } from '../../utils/database.js';
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

export default async function handler(req, res) {
  // Handle CORS
  if (handleCors(req, res)) return;

  const { method, url } = req;

  // Parse URL and query parameters properly for Vercel
  const urlObj = new URL(url, `https://${req.headers.host || 'localhost'}`);
  const urlWithoutQuery = urlObj.pathname;
  const query = Object.fromEntries(urlObj.searchParams);

  // Merge with req.query if it exists (some environments provide it pre-parsed)
  req.query = { ...query, ...req.query };

  const pathParts = urlWithoutQuery.split('/').filter(Boolean);
  
  try {
    // GET /api/templates/schema - Debug: Show database schema
    if (method === 'GET' && pathParts[2] === 'schema') {
      return await getTableSchema(req, res);
    }
    
    // GET /api/templates - List all public templates
    if (method === 'GET' && pathParts.length === 2) {
      return await getTemplates(req, res);
    }
    
    // GET /api/templates/favorites - Get user's favorite templates
    if (method === 'GET' && pathParts[2] === 'favorites') {
      return await getUserFavorites(req, res);
    }
    
    // GET /api/templates/my-templates - Get user's private templates
    if (method === 'GET' && pathParts[2] === 'my-templates') {
      return await getUserTemplates(req, res);
    }
    
    // GET /api/templates/:id - Get single template
    if (method === 'GET' && pathParts.length === 3 && !['favorites', 'my-templates'].includes(pathParts[2])) {
      return await getTemplate(req, res, pathParts[2]);
    }
    
    // POST /api/templates/:id/favorite - Toggle favorite status
    if (method === 'POST' && pathParts.length === 4 && pathParts[3] === 'favorite') {
      return await toggleFavorite(req, res, pathParts[2]);
    }
    
    // POST /api/templates - Create new template
    if (method === 'POST' && pathParts.length === 2) {
      return await createTemplate(req, res);
    }
    
    // PUT /api/templates/:id - Update template
    if (method === 'PUT' && pathParts.length === 3) {
      return await updateTemplate(req, res, pathParts[2]);
    }
    
    // DELETE /api/templates/:id - Delete template
    if (method === 'DELETE' && pathParts.length === 3) {
      return await deleteTemplate(req, res, pathParts[2]);
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
    SELECT t.*,
           u.username,
           (SELECT COUNT(*) FROM user_favorites uf WHERE uf.template_id = t.id) as favorite_count,
           ${userId ? `EXISTS(SELECT 1 FROM user_favorites uf WHERE uf.template_id = t.id AND uf.user_id = $1) as user_favorited` : 'false as user_favorited'}
    FROM templates t
    LEFT JOIN users u ON t.user_id = u.id
    WHERE t.is_public = true
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
    query += ` AND t.category = ANY($${paramCount})`;
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
      query += ` AND t.category = ANY($${paramCount})`;
      params.push(categoriesList);
    }
  }
  
  // Search filtering - enhanced to include tags and creator
  if (search) {
    paramCount++;
    query += ` AND (
      t.name ILIKE $${paramCount} OR
      t.description ILIKE $${paramCount} OR
      u.username ILIKE $${paramCount} OR
      EXISTS(SELECT 1 FROM unnest(t.tags) as tag WHERE tag ILIKE $${paramCount})
    )`;
    params.push(`%${search}%`);
  }
  
  // Tag filtering - support multiple tags with OR logic (template must have ANY of the selected tags)
  if (tags) {
    let tagsList;
    try {
      tagsList = Array.isArray(tags) ? tags : JSON.parse(tags);
    } catch {
      tagsList = typeof tags === 'string' ? tags.split(',').map(t => t.trim()) : [];
    }

    if (tagsList.length > 0) {
      // Template must have at least one of the selected tags (OR logic)
      const tagConditions = tagsList.map(tag => {
        paramCount++;
        params.push(`%${tag}%`);
        return `template_tag ILIKE $${paramCount}`;
      }).join(' OR ');

      query += ` AND EXISTS(SELECT 1 FROM unnest(t.tags) as template_tag WHERE ${tagConditions})`;
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
      query += ` AND t.id != ALL($${paramCount})`;
      params.push(excludeIdsList);
    }
  }

  // Sorting
  let orderClause = 'ORDER BY ';
  switch (sortBy) {
    case 'alphabetical':
      orderClause += 't.name ASC';
      break;
    case 'rating':
      orderClause += 'favorite_count DESC, t.created_at DESC';
      break;
    case 'downloads':
    case 'usage':
      orderClause += 'favorite_count DESC, t.created_at DESC';
      break;
    case 'recent':
      orderClause += 't.updated_at DESC';
      break;
    case 'relevance':
      if (search) {
        orderClause += `
          (CASE
            WHEN t.name ILIKE $${params.findIndex(p => p === `%${search}%`) + 1} THEN 1
            WHEN t.description ILIKE $${params.findIndex(p => p === `%${search}%`) + 1} THEN 2
            ELSE 3
          END) ASC, favorite_count DESC, t.created_at DESC`;
      } else {
        orderClause += 'favorite_count DESC, t.created_at DESC';
      }
      break;
    default:
      orderClause += 't.created_at DESC';
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
    FROM templates t
    WHERE t.is_public = true
  `;
  const countParams = [];
  let countParamCount = 0;
  
  // Apply the same filters to count query (matching the main query logic)
  if (categories) {
    // Multiple categories
    let categoriesList;
    try {
      categoriesList = Array.isArray(categories) ? categories : JSON.parse(categories);
    } catch {
      categoriesList = typeof categories === 'string' ? categories.split(',').map(c => c.trim()) : [];
    }
    if (categoriesList.length > 0) {
      countParamCount++;
      countQuery += ` AND t.category = ANY($${countParamCount})`;
      countParams.push(categoriesList);
    }
  } else if (category) {
    // Single category
    countParamCount++;
    countQuery += ` AND t.category = $${countParamCount}`;
    countParams.push(category);
  } else if (parents) {
    // Multiple parents
    let parentsList;
    try {
      parentsList = Array.isArray(parents) ? parents : JSON.parse(parents);
    } catch {
      parentsList = typeof parents === 'string' ? parents.split(',').map(p => p.trim()) : [];
    }
    if (parentsList.length > 0) {
      // Get all categories for all parents
      const allParentCategories = [];
      parentsList.forEach(parentId => {
        const parentCategories = getChildCategoriesForParent(parentId);
        allParentCategories.push(...parentCategories, parentId);
      });
      if (allParentCategories.length > 0) {
        countParamCount++;
        countQuery += ` AND t.category = ANY($${countParamCount})`;
        countParams.push(allParentCategories);
      }
    }
  } else if (parent) {
    // Single parent
    const parentCategories = getChildCategoriesForParent(parent);
    if (parentCategories.length > 0) {
      countParamCount++;
      countQuery += ` AND (t.category = ANY($${countParamCount}) OR t.category = $${countParamCount + 1})`;
      countParams.push(parentCategories);
      countParamCount++;
      countParams.push(parent);
    }
  } else if (grandparents) {
    // Multiple grandparents
    let grandparentsList;
    try {
      grandparentsList = Array.isArray(grandparents) ? grandparents : JSON.parse(grandparents);
    } catch {
      grandparentsList = typeof grandparents === 'string' ? grandparents.split(',').map(g => g.trim()) : [];
    }
    if (grandparentsList.length > 0) {
      // Get all descendants for all grandparents
      const allDescendantCategories = [];
      grandparentsList.forEach(grandparentId => {
        const descendantCategories = getDescendantCategoriesForGrandparent(grandparentId);
        allDescendantCategories.push(...descendantCategories, grandparentId);
      });
      if (allDescendantCategories.length > 0) {
        countParamCount++;
        countQuery += ` AND t.category = ANY($${countParamCount})`;
        countParams.push(allDescendantCategories);
      }
    }
  } else if (grandparent) {
    // Single grandparent
    const descendantCategories = getDescendantCategoriesForGrandparent(grandparent);
    if (descendantCategories.length > 0) {
      countParamCount++;
      countQuery += ` AND (t.category = ANY($${countParamCount}) OR t.category = $${countParamCount + 1})`;
      countParams.push(descendantCategories);
      countParamCount++;
      countParams.push(grandparent);
    }
  }
  
  if (search) {
    countParamCount++;
    countQuery += ` AND (
      t.name ILIKE $${countParamCount} OR
      t.description ILIKE $${countParamCount} OR
      EXISTS(
        SELECT 1 FROM users u
        WHERE u.id = t.user_id AND u.username ILIKE $${countParamCount}
      ) OR
      EXISTS(SELECT 1 FROM unnest(t.tags) as tag WHERE tag ILIKE $${countParamCount})
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
      // Template must have at least one of the selected tags (OR logic)
      const tagConditions = tagsList.map(tag => {
        countParamCount++;
        countParams.push(`%${tag}%`);
        return `template_tag ILIKE $${countParamCount}`;
      }).join(' OR ');

      countQuery += ` AND EXISTS(SELECT 1 FROM unnest(t.tags) as template_tag WHERE ${tagConditions})`;
    }
  }

  // Apply the same excludeIds filter to count query
  if (excludeIds) {
    let excludeIdsList;
    try {
      excludeIdsList = Array.isArray(excludeIds) ? excludeIds : JSON.parse(excludeIds);
    } catch {
      excludeIdsList = typeof excludeIds === 'string' ? excludeIds.split(',').map(id => id.trim()) : [];
    }

    if (excludeIdsList.length > 0) {
      countParamCount++;
      countQuery += ` AND t.id != ALL($${countParamCount})`;
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
    const template = {
      id: row.id,
      name: row.name,
      description: row.description,
      content: row.content,
      category: row.category,
      tags: row.tags,
      is_public: row.is_public,
      favorite_count: favoriteCount,
      created_at: row.created_at,
      updated_at: row.updated_at,
      username: row.username,
      userInteractions: userId ? {
        isFavorited: row.user_favorited
      } : null,
      engagement: {
        favorites: favoriteCount
      }
    };

    // Enrich with hierarchical category structure
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
    const userResult = await db.query('SELECT username FROM users WHERE id = $1', [userId]);
    console.log('🔍 DEBUG getUserTemplates - userResult:', userResult.rows);
    
    if (userResult.rows.length === 0) {
      console.log('❌ DEBUG getUserTemplates - User not found in database');
      return res.status(404).json(error('User not found', 404));
    }
    
    const username = userResult.rows[0].username;
    console.log('🔍 DEBUG getUserTemplates - username:', username);
    
    // Get all templates created by this user (both public and private)
    const query = `
      SELECT t.*,
             u.username,
             (SELECT COUNT(*) FROM user_favorites uf WHERE uf.template_id = t.id) as favorite_count,
             false as user_favorited
      FROM templates t
      JOIN users u ON t.user_id = u.id
      WHERE t.user_id = $1
      ORDER BY t.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await db.query(query, [userId, parseInt(limit), parseInt(offset)]);
    
    console.log('🔍 DEBUG getUserTemplates - query result:', {
      rowCount: result.rows.length,
      templates: result.rows.map(r => ({ id: r.id, name: r.name, username: r.username, is_public: r.is_public }))
    });

    const templates = result.rows.map(row => {
      const favoriteCount = parseInt(row.favorite_count) || 0;
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        content: row.content,
        category: row.category,
        tags: row.tags,
        is_public: row.is_public,
        favorite_count: favoriteCount,
        created_at: row.created_at,
        updated_at: row.updated_at,
        username: row.username,
        userInteractions: {
          isFavorited: false // User's own templates, favoriting not applicable
        },
        engagement: {
          favorites: favoriteCount
        }
      };
    });

    // Apply hierarchy enrichment
    const enrichedTemplates = templates.map(template => enrichWithHierarchy(template));

    return res.json({
      templates: enrichedTemplates,
      total: enrichedTemplates.length,
      public_count: enrichedTemplates.filter(t => t.is_public).length,
      private_count: enrichedTemplates.filter(t => !t.is_public).length
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
    // If user is authenticated, allow access to shared templates OR their own private templates
    query = `
      SELECT t.*,
             u.username,
             (SELECT COUNT(*) FROM user_favorites uf WHERE uf.template_id = t.id) as favorite_count,
             EXISTS(SELECT 1 FROM user_favorites uf WHERE uf.template_id = t.id AND uf.user_id = $2) as user_favorited
      FROM templates t
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.id = $1 AND (t.is_public = true OR t.user_id = $2)
    `;
    params = [templateId, userId];
  } else {
    // If user is not authenticated, only allow shared templates
    console.log('🔍 DEBUG getTemplate - No userId, using shared-only query');
    query = `
      SELECT t.*,
             u.username,
             (SELECT COUNT(*) FROM user_favorites uf WHERE uf.template_id = t.id) as favorite_count,
             false as user_favorited
      FROM templates t
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.id = $1 AND t.is_public = true
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
      name: result.rows[0].name,
      username: result.rows[0].username,
      is_public: result.rows[0].is_public
    } : null
  });
  
  if (result.rows.length === 0) {
    console.log('❌ DEBUG getTemplate - Template not found or access denied');
    return res.status(404).json(error('Template not found', 404));
  }
  
  const template = result.rows[0];
  const favoriteCount = parseInt(template.favorite_count) || 0;

  const enrichedTemplate = {
    ...template,
    favorite_count: favoriteCount,
    creator: template.username ? {
      username: template.username,
      displayName: template.username,
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(template.username)}&background=6366f1&color=fff`
    } : null,
    userInteractions: userId ? {
      isFavorited: template.user_favorited
    } : null,
    engagement: {
      favorites: favoriteCount
    }
  };
  
  // FIXED: Use consistent wrapper format like other endpoints
  const finalTemplate = enrichWithHierarchy(enrichedTemplate);
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
    SELECT t.*,
           u.username,
           uf.created_at as favorited_at,
           (SELECT COUNT(*) FROM user_favorites uf2 WHERE uf2.template_id = t.id) as favorite_count
    FROM user_favorites uf
    JOIN templates t ON uf.template_id = t.id
    LEFT JOIN users u ON t.user_id = u.id
    WHERE uf.user_id = $1 AND t.is_public = true
    ORDER BY uf.created_at DESC
    LIMIT $2 OFFSET $3
  `;

  const result = await db.query(query, [user.id, parseInt(limit), parseInt(offset)]);

  const countQuery = `
    SELECT COUNT(*)
    FROM user_favorites uf
    JOIN templates t ON uf.template_id = t.id
    WHERE uf.user_id = $1 AND t.is_public = true
  `;
  const countResult = await db.query(countQuery, [user.id]);
  const totalCount = parseInt(countResult.rows[0].count);
  
  const favorites = result.rows.map(row => {
    const favoriteCount = parseInt(row.favorite_count) || 0;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      content: row.content,
      category: row.category,
      tags: row.tags,
      is_public: row.is_public,
      favorite_count: favoriteCount,
      created_at: row.created_at,
      favorited_at: row.favorited_at,
      username: row.username,
      userInteractions: {
        isFavorited: true
      },
      engagement: {
        favorites: favoriteCount
      }
    };
  });

  // Apply hierarchy enrichment to favorites
  const enrichedFavorites = favorites.map(template => enrichWithHierarchy(template));

  // FIXED: Use consistent 'templates' property name like other endpoints
  return res.json({
    templates: enrichedFavorites,  // Changed from 'favorites' to 'templates'
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
  
  // Validate UUID format (PostgreSQL UUID format)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(templateId)) {
    console.log('❌ API - Invalid template ID format:', templateId);
    return res.status(400).json(error('Invalid template ID format', 400));
  }
  
  // Check if template exists and is shared
  const templateResult = await db.query(
    'SELECT id FROM templates WHERE id = $1 AND is_public = true',
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
    'SELECT id FROM user_favorites WHERE user_id = $1 AND template_id = $2',
    [user.id, templateId]
  );

  console.log('❤️ API - Existing favorite check:', {
    userId: user.id,
    templateId,
    alreadyFavorited: existingFavorite.rows.length > 0
  });

  let isFavorited;

  if (existingFavorite.rows.length > 0) {
    // Remove from favorites
    console.log('➖ API - Removing from favorites');
    await db.query('DELETE FROM user_favorites WHERE user_id = $1 AND template_id = $2', [user.id, templateId]);
    isFavorited = false;
  } else {
    // Add to favorites
    console.log('➕ API - Adding to favorites');
    await db.query('INSERT INTO user_favorites (user_id, template_id) VALUES ($1, $2)', [user.id, templateId]);
    isFavorited = true;
  }

  // Get updated favorite count
  const countResult = await db.query('SELECT COUNT(*) as count FROM user_favorites WHERE template_id = $1', [templateId]);
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

    // Name and content are required, description is optional (defaults to empty string in DB)
    if (!name || !content) {
      return res.status(400).json(error('Name and content are required', 400));
    }

    // Ensure category is never null (required by database constraint)
    const validCategory = category || 'general';

    // Variables should be JSONB array
    const normalizedVariables = Array.isArray(variables) ? variables : [];

    // Ensure description defaults to empty string if not provided
    const normalizedDescription = description || '';

    const result = await db.query(`
      INSERT INTO templates (user_id, name, description, content, variables, category, tags, is_public)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [user.id, name, normalizedDescription, content, normalizedVariables, validCategory, normalizedTags, is_public || false]);
    
    console.log('🔍 API DEBUG: Raw DB result:', result.rows[0]);
    console.log('🔍 API DEBUG: User object:', user);
    
    // Return the template with consistent structure like other endpoints
    const baseTemplate = {
      ...result.rows[0],
      username: user.username, // Direct username field for consistency
      // Add user interaction data for consistency
      userInteractions: {
        isFavorited: false, // Newly created templates start unfavorited
        isOwner: true
      },
      // Add engagement data for consistency
      engagement: {
        favorites: 0,
        downloads: 0,
        ratings: { average: 0, count: 0 }
      }
    };
    
    // Debug logging
    console.log('🔍 API DEBUG: Base template before enrichment:', baseTemplate);
    
    // Enrich with hierarchical category structure (same as other endpoints)
    const enrichedTemplate = enrichWithHierarchy(baseTemplate);
    
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
  const existingTemplate = await db.query(
    'SELECT id, user_id FROM templates WHERE id = $1',
    [templateId]
  );

  if (existingTemplate.rows.length === 0) {
    return res.status(404).json(error('Template not found', 404));
  }

  if (existingTemplate.rows[0].user_id !== user.id) {
    return res.status(403).json(error('You can only update your own templates', 403));
  }
  
  const { name, description, content, variables, category, tags, is_public } = req.body;

  // Name and content are required, description is optional (defaults to empty string in DB)
  if (!name || !content) {
    return res.status(400).json(error('Name and content are required', 400));
  }

  // Ensure category is never null (required by database constraint)
  const validCategory = category || 'general';

  // Tags should now be simple arrays throughout the system
  const normalizedTags = Array.isArray(tags) ? tags : [];

  // Variables should be JSONB array
  const normalizedVariables = Array.isArray(variables) ? variables : [];

  // Ensure description defaults to empty string if not provided
  const normalizedDescription = description || '';

  const result = await db.query(`
    UPDATE templates
    SET name = $2, description = $3, content = $4, variables = $5,
        category = $6, tags = $7, is_public = $8, updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [templateId, name, normalizedDescription, content, normalizedVariables, validCategory, normalizedTags, is_public || false]);
  
  return res.json(success(result.rows[0], 'Template updated successfully'));
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
  const existingTemplate = await db.query(
    'SELECT id, user_id, name FROM templates WHERE id = $1',
    [templateId]
  );

  if (existingTemplate.rows.length === 0) {
    return res.status(404).json(error('Template not found', 404));
  }

  if (existingTemplate.rows[0].user_id !== user.id) {
    return res.status(403).json(error('You can only delete your own templates', 403));
  }
  
  // Delete template (CASCADE will automatically delete related user_favorites)
  await db.query('DELETE FROM templates WHERE id = $1', [templateId]);
  
  return res.json(success({ 
    id: templateId, 
    name: existingTemplate.rows[0].name 
  }, 'Template deleted successfully'));
}

// Helper function to get child categories for a parent
function getChildCategoriesForParent(parentId) {
  const childCategories = [];
  
  TEMPLATE_CATEGORIES.forEach(grandparent => {
    grandparent.children.forEach(parent => {
      if (parent.id === parentId && parent.children) {
        parent.children.forEach(category => {
          childCategories.push(category.id);
        });
      }
    });
  });
  
  return childCategories;
}

// Helper function to get all descendant categories for a grandparent
function getDescendantCategoriesForGrandparent(grandparentId) {
  const descendantCategories = [];

  TEMPLATE_CATEGORIES.forEach(grandparent => {
    if (grandparent.id === grandparentId) {
      grandparent.children.forEach(parent => {
        // Add parent itself
        descendantCategories.push(parent.id);

        // Add all children of parent
        if (parent.children) {
          parent.children.forEach(category => {
            descendantCategories.push(category.id);
          });
        }
      });
    }
  });

  console.log(`🔍 [API] getDescendantCategoriesForGrandparent('${grandparentId}') found ${descendantCategories.length} categories:`, descendantCategories);

  return descendantCategories;
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

// Debug function to check database schema
async function getTableSchema(req, res) {
  try {
    const query = `
      SELECT column_name, data_type, character_maximum_length, column_default, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'templates'
      ORDER BY ordinal_position;
    `;
    
    const result = await db.query(query);
    
    return res.json({
      table: 'templates',
      columns: result.rows
    });
    
  } catch (error) {
    console.error('Schema query error:', error);
    return res.status(500).json(error('Failed to get schema', 500));
  }
}