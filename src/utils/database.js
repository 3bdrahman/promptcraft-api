import pg from 'pg';

// Lazy-initialize pool for Vercel serverless functions
let pool = null;

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

// Database connection object
export const db = {
  query: async (text, params) => {
    const pool = getPool();
    return await pool.query(text, params);
  },
  connect: async () => {
    const pool = getPool();
    return await pool.connect();
  },
  getClient: async () => {
    const pool = getPool();
    return await pool.connect();
  }
};

// Test database connection
export const testConnection = async () => {
  try {
    const client = await db.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
};

/**
 * Helper functions for new enterprise schema
 */

/**
 * Get or create tenant for a user (for migration compatibility)
 * In production, tenants would be created explicitly
 */
export async function ensureTenant(userId, client = null) {
  const executor = client || db;

  try {
    // Check if user already has a tenant
    const userResult = await executor.query(
      'SELECT tenant_id FROM "user" WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length > 0 && userResult.rows[0].tenant_id) {
      return userResult.rows[0].tenant_id;
    }

    // Create default tenant for user
    const tenantResult = await executor.query(
      `INSERT INTO tenant (name, slug, settings)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET slug = tenant.slug
       RETURNING id`,
      [`User ${userId} Workspace`, `user-${userId}`, {}]
    );

    return tenantResult.rows[0].id;
  } catch (error) {
    console.error('Error ensuring tenant:', error);
    throw error;
  }
}

/**
 * Get current version of an entity
 */
export async function getCurrentEntity(entityId, client = null) {
  const executor = client || db;

  const result = await executor.query(
    `SELECT * FROM entity
     WHERE id = $1 AND valid_to IS NULL AND deleted_at IS NULL`,
    [entityId]
  );

  return result.rows[0] || null;
}

/**
 * Create a new entity with proper versioning
 */
export async function createEntity({
  tenantId,
  ownerId,
  entityType,
  title,
  description,
  content,
  tags = [],
  metadata = {},
  status = 'draft',
  visibility = 'private',
  client = null
}) {
  const executor = client || db;

  const result = await executor.query(
    `INSERT INTO entity (
      tenant_id, owner_id, entity_type, title, description,
      content, tags, metadata, status, visibility
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [tenantId, ownerId, entityType, title, description, content, tags, metadata, status, visibility]
  );

  return result.rows[0];
}

/**
 * Update an entity (creates new version)
 */
export async function updateEntity(entityId, updates, userId, client = null) {
  const executor = client || db;

  // Get current version
  const current = await getCurrentEntity(entityId, executor);
  if (!current) {
    throw new Error('Entity not found');
  }

  // Close current version
  await executor.query(
    `UPDATE entity SET valid_to = NOW() WHERE id = $1 AND valid_to IS NULL`,
    [entityId]
  );

  // Create new version
  const newVersion = {
    ...current,
    ...updates,
    version: current.version + 1,
    previous_version_id: entityId,
    valid_from: new Date(),
    valid_to: null,
    updated_at: new Date()
  };

  delete newVersion.id;
  delete newVersion.created_at;

  const result = await executor.query(
    `INSERT INTO entity (
      tenant_id, owner_id, entity_type, title, description, content,
      tags, metadata, status, visibility, version, valid_from, valid_to,
      previous_version_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *`,
    [
      newVersion.tenant_id, newVersion.owner_id, newVersion.entity_type,
      newVersion.title, newVersion.description, newVersion.content,
      newVersion.tags, newVersion.metadata, newVersion.status,
      newVersion.visibility, newVersion.version, newVersion.valid_from,
      newVersion.valid_to, newVersion.previous_version_id
    ]
  );

  // Log event
  await logEvent({
    tenantId: current.tenant_id,
    eventType: 'entity.updated',
    aggregateType: 'entity',
    aggregateId: result.rows[0].id,
    actorId: userId,
    payload: { updates, previousVersion: entityId },
    client: executor
  });

  return result.rows[0];
}

/**
 * Soft delete an entity
 */
export async function deleteEntity(entityId, userId, client = null) {
  const executor = client || db;

  const current = await getCurrentEntity(entityId, executor);
  if (!current) {
    throw new Error('Entity not found');
  }

  const result = await executor.query(
    `UPDATE entity
     SET deleted_at = NOW(), purge_at = NOW() + INTERVAL '30 days'
     WHERE id = $1 AND valid_to IS NULL
     RETURNING *`,
    [entityId]
  );

  // Log event
  await logEvent({
    tenantId: current.tenant_id,
    eventType: 'entity.deleted',
    aggregateType: 'entity',
    aggregateId: entityId,
    actorId: userId,
    payload: { entityType: current.entity_type },
    client: executor
  });

  return result.rows[0];
}

/**
 * Log an event to the event sourcing table
 */
export async function logEvent({
  tenantId,
  eventType,
  aggregateType,
  aggregateId,
  actorId = null,
  payload = {},
  metadata = {},
  client = null
}) {
  const executor = client || db;

  await executor.query(
    `INSERT INTO event (tenant_id, event_type, aggregate_type, aggregate_id, actor_id, payload, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, eventType, aggregateType, aggregateId, actorId, payload, metadata]
  );
}

/**
 * Track usage event
 */
export async function trackUsage({
  tenantId,
  userId = null,
  entityId = null,
  eventType,
  tokensUsed = 0,
  costUsd = 0,
  durationMs = null,
  metadata = {},
  client = null
}) {
  const executor = client || db;

  await executor.query(
    `INSERT INTO usage_event (tenant_id, user_id, entity_id, event_type, tokens_used, cost_usd, duration_ms, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, userId, entityId, eventType, tokensUsed, costUsd, durationMs, metadata]
  );
}