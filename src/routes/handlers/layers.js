/**
 * Context Layers API - Updated for Enterprise Schema
 * Uses universal entity table with entity_type = 'context'
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
import { getUserId } from '../../middleware/auth/index.js';
import { success, error, handleCors } from '../../utils/responses.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const { method, url } = req;

  // Parse URL and query parameters
  const urlObj = new URL(url, `https://${req.headers.host || 'localhost'}`);
  const pathParts = urlObj.pathname.split('/').filter(Boolean);
  const query = Object.fromEntries(urlObj.searchParams);

  req.query = { ...query, ...req.query };

  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    // Ensure user has a tenant
    const tenantId = await ensureTenant(userId);

    // GET / - List layers with filters
    if (method === 'GET' && pathParts.length === 0) {
      const {
        type, // layer_type filter (mapped to metadata.layer_type)
        tags,
        visibility,
        is_template,
        search,
        sort = 'updated_at',
        order = 'DESC',
        limit = 50,
        offset = 0
      } = req.query;

      let query = `
        SELECT e.*,
          COALESCE((SELECT COUNT(*) FROM favorite f WHERE f.entity_id = e.id), 0) as favorite_count,
          COALESCE(es.usage_last_30d, 0) as usage_count
        FROM entity e
        LEFT JOIN entity_stats es ON e.id = es.entity_id
        WHERE e.owner_id = $1
          AND e.entity_type = 'context'
          AND e.valid_to IS NULL
          AND e.deleted_at IS NULL
      `;
      const params = [userId];
      let paramCount = 1;

      // Apply filters
      if (type) {
        paramCount++;
        query += ` AND e.metadata->>'layer_type' = $${paramCount}`;
        params.push(type);
      }

      if (tags) {
        paramCount++;
        query += ` AND e.tags && $${paramCount}`;
        params.push(tags.split(','));
      }

      if (visibility) {
        paramCount++;
        query += ` AND e.visibility = $${paramCount}`;
        params.push(visibility);
      }

      if (is_template !== undefined) {
        paramCount++;
        query += ` AND (e.metadata->>'is_template')::boolean = $${paramCount}`;
        params.push(is_template === 'true');
      }

      if (search) {
        paramCount++;
        query += ` AND (e.title ILIKE $${paramCount} OR e.description ILIKE $${paramCount} OR e.content::text ILIKE $${paramCount})`;
        params.push(`%${search}%`);
      }

      // Sorting
      const validSortFields = ['title', 'created_at', 'updated_at', 'usage_count'];
      const sortField = validSortFields.includes(sort) ? sort : 'updated_at';
      const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      query += ` ORDER BY ${sortField} ${sortOrder}`;

      // Pagination
      paramCount++;
      query += ` LIMIT $${paramCount}`;
      params.push(parseInt(limit));

      paramCount++;
      query += ` OFFSET $${paramCount}`;
      params.push(parseInt(offset));

      const result = await db.query(query, params);

      // Map to old format for compatibility
      const layers = result.rows.map(row => ({
        id: row.id,
        user_id: row.owner_id,
        name: row.title,
        description: row.description,
        content: typeof row.content === 'string' ? row.content : JSON.stringify(row.content),
        layer_type: row.metadata?.layer_type || 'adhoc',
        tags: row.tags,
        metadata: row.metadata,
        visibility: row.visibility,
        is_template: row.metadata?.is_template || false,
        usage_count: parseInt(row.usage_count) || 0,
        favorite_count: parseInt(row.favorite_count) || 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at
      }));

      return res.json(success(layers));
    }

    // GET /search - Search layers
    if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'search') {
      const { q, limit = 10 } = req.query;

      if (!q || q.trim().length < 2) {
        return res.json(success({ layers: [] }));
      }

      const result = await db.query(
        `SELECT e.id, e.title as name, e.description,
                e.metadata->>'layer_type' as layer_type, e.tags,
                COALESCE(es.usage_last_30d, 0) as usage_count
         FROM entity e
         LEFT JOIN entity_stats es ON e.id = es.entity_id
         WHERE e.owner_id = $1
           AND e.entity_type = 'context'
           AND e.valid_to IS NULL
           AND e.deleted_at IS NULL
           AND (e.title ILIKE $2 OR e.description ILIKE $2 OR e.content::text ILIKE $2)
         ORDER BY es.usage_last_30d DESC NULLS LAST, e.updated_at DESC
         LIMIT $3`,
        [userId, `%${q}%`, parseInt(limit)]
      );

      return res.json(success({ layers: result.rows }));
    }

    // GET /:id - Get single layer
    if (method === 'GET' && pathParts.length === 1 && pathParts[0] !== 'search') {
      const layerId = pathParts[0];

      const result = await db.query(
        `SELECT e.*,
                COALESCE((SELECT COUNT(*) FROM favorite f WHERE f.entity_id = e.id), 0) as favorite_count,
                COALESCE(es.usage_last_30d, 0) as usage_count
         FROM entity e
         LEFT JOIN entity_stats es ON e.id = es.entity_id
         WHERE e.id = $1 AND e.owner_id = $2 AND e.entity_type = 'context'
           AND e.valid_to IS NULL AND e.deleted_at IS NULL`,
        [layerId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json(error('Layer not found', 404));
      }

      const row = result.rows[0];
      const layer = {
        id: row.id,
        user_id: row.owner_id,
        name: row.title,
        description: row.description,
        content: typeof row.content === 'string' ? row.content : JSON.stringify(row.content),
        layer_type: row.metadata?.layer_type || 'adhoc',
        tags: row.tags,
        metadata: row.metadata,
        visibility: row.visibility,
        is_template: row.metadata?.is_template || false,
        usage_count: parseInt(row.usage_count) || 0,
        favorite_count: parseInt(row.favorite_count) || 0,
        created_at: row.created_at,
        updated_at: row.updated_at
      };

      return res.json(success({ layer }));
    }

    // POST / - Create layer
    if (method === 'POST' && pathParts.length === 0) {
      const {
        name,
        description,
        content,
        layer_type,
        tags = [],
        metadata = {},
        visibility = 'private',
        is_template = false
      } = req.body;

      console.log('🔍 [CREATE LAYER] Received request body:', JSON.stringify(req.body, null, 2));

      // Validation
      if (!name || !content || !layer_type) {
        console.log('❌ [CREATE LAYER] Validation failed:', {
          hasName: !!name,
          hasContent: !!content,
          hasLayerType: !!layer_type
        });
        return res.status(400).json(error('Name, content, and layer_type are required'));
      }

      const validTypes = ['profile', 'project', 'task', 'snippet', 'adhoc'];
      if (!validTypes.includes(layer_type)) {
        console.log('❌ [CREATE LAYER] Invalid layer_type:', layer_type);
        return res.status(400).json(error(`Invalid layer_type. Must be one of: ${validTypes.join(', ')}`));
      }

      console.log('✅ [CREATE LAYER] Validation passed, creating entity...');

      // Check subscription limits
      const limitCheck = await checkLayerLimit(userId, tenantId);
      if (!limitCheck.allowed) {
        return res.status(403).json(error(limitCheck.message, 403));
      }

      // Create entity
      const entity = await createEntity({
        tenantId,
        ownerId: userId,
        entityType: 'context',
        title: name,
        description,
        content: { text: content }, // Store as JSONB
        tags,
        metadata: { ...metadata, layer_type, is_template },
        visibility,
        status: 'published'
      });

      // Log event
      await logEvent({
        tenantId,
        eventType: 'entity.created',
        aggregateType: 'entity',
        aggregateId: entity.id,
        actorId: userId,
        payload: { entityType: 'context', layer_type }
      });

      // Map to old format
      const layer = {
        id: entity.id,
        user_id: entity.owner_id,
        name: entity.title,
        description: entity.description,
        content: entity.content.text || JSON.stringify(entity.content),
        layer_type,
        tags: entity.tags,
        metadata: entity.metadata,
        visibility: entity.visibility,
        is_template,
        created_at: entity.created_at,
        updated_at: entity.updated_at
      };

      return res.status(201).json(success({ layer }));
    }

    // PUT /:id - Update layer
    if (method === 'PUT' && pathParts.length === 1) {
      const layerId = pathParts[0];
      const {
        name,
        description,
        content,
        layer_type,
        tags,
        metadata,
        visibility,
        is_template
      } = req.body;

      // Verify ownership
      const current = await getCurrentEntity(layerId);
      if (!current || current.owner_id !== userId || current.entity_type !== 'context') {
        return res.status(404).json(error('Layer not found', 404));
      }

      // Build updates object
      const updates = {};
      if (name !== undefined) updates.title = name;
      if (description !== undefined) updates.description = description;
      if (content !== undefined) updates.content = { text: content };
      if (tags !== undefined) updates.tags = tags;
      if (visibility !== undefined) updates.visibility = visibility;

      // Update metadata
      if (layer_type !== undefined || is_template !== undefined || metadata !== undefined) {
        updates.metadata = {
          ...current.metadata,
          ...metadata,
          ...(layer_type && { layer_type }),
          ...(is_template !== undefined && { is_template })
        };
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json(error('No fields to update'));
      }

      // Update entity (creates new version)
      const updated = await updateEntity(layerId, updates, userId);

      // Map to old format
      const layer = {
        id: updated.id,
        user_id: updated.owner_id,
        name: updated.title,
        description: updated.description,
        content: updated.content.text || JSON.stringify(updated.content),
        layer_type: updated.metadata?.layer_type || 'adhoc',
        tags: updated.tags,
        metadata: updated.metadata,
        visibility: updated.visibility,
        is_template: updated.metadata?.is_template || false,
        created_at: updated.created_at,
        updated_at: updated.updated_at
      };

      return res.json(success({ layer }));
    }

    // DELETE /:id - Soft delete layer
    if (method === 'DELETE' && pathParts.length === 1) {
      const layerId = pathParts[0];

      const current = await getCurrentEntity(layerId);
      if (!current || current.owner_id !== userId || current.entity_type !== 'context') {
        return res.status(404).json(error('Layer not found', 404));
      }

      await deleteEntity(layerId, userId);

      return res.json(success({
        id: layerId,
        name: current.title,
        deleted: true
      }));
    }

    // POST /:id/use - Track usage
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'use') {
      const layerId = pathParts[0];

      const current = await getCurrentEntity(layerId);
      if (!current || current.owner_id !== userId || current.entity_type !== 'context') {
        return res.status(404).json(error('Layer not found', 404));
      }

      // Track usage event
      await trackUsage({
        tenantId,
        userId,
        entityId: layerId,
        eventType: 'entity.used'
      });

      return res.json(success({ id: layerId, tracked: true }));
    }

    // POST /:id/rating - Rate layer (now uses favorite table)
    if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'rating') {
      const layerId = pathParts[0];

      const current = await getCurrentEntity(layerId);
      if (!current || current.owner_id !== userId || current.entity_type !== 'context') {
        return res.status(404).json(error('Layer not found', 404));
      }

      // Add to favorites
      await db.query(
        `INSERT INTO favorite (user_id, entity_id) VALUES ($1, $2)
         ON CONFLICT (user_id, entity_id) DO NOTHING`,
        [userId, layerId]
      );

      const favCount = await db.query(
        'SELECT COUNT(*) FROM favorite WHERE entity_id = $1',
        [layerId]
      );

      return res.json(success({
        id: layerId,
        favorite_count: parseInt(favCount.rows[0].count)
      }));
    }

    // GET /:id/versions - Get version history
    if (method === 'GET' && pathParts.length === 2 && pathParts[1] === 'versions') {
      const layerId = pathParts[0];

      const versions = await db.query(
        'SELECT * FROM get_entity_history($1) ORDER BY version DESC LIMIT 50',
        [layerId]
      );

      return res.json(success({
        layer_id: layerId,
        versions: versions.rows,
        total: versions.rows.length
      }));
    }

    return res.status(404).json(error('Not found', 404));

  } catch (err) {
    console.error('Context Layers API Error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * Check if user can create more layers based on subscription tier
 */
async function checkLayerLimit(userId, tenantId) {
  try {
    // Get tenant usage from materialized view
    const tierResult = await db.query(
      `SELECT context_count, active_entity_count
       FROM tenant_usage_summary
       WHERE tenant_id = $1`,
      [tenantId]
    );

    // For now, allow unlimited (can add limits later based on tenant settings)
    return { allowed: true };

  } catch (err) {
    console.error('Layer limit check error:', err);
    return { allowed: true }; // Fail open
  }
}
