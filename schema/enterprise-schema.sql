-- Enterprise-Grade Database Schema for PromptCraft
-- Design Principles:
-- 1. Temporal versioning (valid_from/valid_to) for all core entities
-- 2. Event sourcing + CQRS for auditability and scalability
-- 3. Normalized design with strategic denormalization for performance
-- 4. Partitioning for hot tables (events, usage)
-- 5. Materialized views for read model optimization
-- 6. Vector embeddings with pgvector for semantic search
-- 7. Row-Level Security ready for multi-tenancy
-- 8. Zero triggers on hot write paths

-- Prerequisites
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================================
-- TENANT & USER DOMAIN
-- ============================================================================

CREATE TABLE tenant (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "user" (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  avatar_url TEXT,
  oauth_provider VARCHAR(50),
  oauth_id VARCHAR(255),
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);

CREATE INDEX idx_user_tenant ON "user"(tenant_id);
CREATE INDEX idx_user_oauth ON "user"(oauth_provider, oauth_id);

-- ============================================================================
-- AUTHENTICATION & SESSION
-- ============================================================================

CREATE TABLE session (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token VARCHAR(512) NOT NULL,
  refresh_token VARCHAR(512) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fixed: Removed NOW() comparison from WHERE clause
CREATE INDEX idx_session_user ON session(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_session_expires ON session(expires_at);
CREATE INDEX idx_session_access_token ON session(access_token);

-- ============================================================================
-- CORE ENTITY SYSTEM (Temporal Versioning)
-- ============================================================================

-- Universal entity table with versioning
-- All content types: context, template, workflow, library, etc.
CREATE TABLE entity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type VARCHAR(50) NOT NULL, -- 'context', 'template', 'workflow', 'library'
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- Temporal versioning (SQL:2011 pattern)
  version INTEGER NOT NULL DEFAULT 1,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ, -- NULL = current version
  previous_version_id UUID REFERENCES entity(id),

  -- Core attributes (normalized for queries)
  title VARCHAR(500) NOT NULL,
  description TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'draft', -- draft, published, archived
  visibility VARCHAR(50) NOT NULL DEFAULT 'private', -- private, shared, public

  -- Content (specific to entity type)
  content JSONB NOT NULL DEFAULT '{}',

  -- Metadata
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,

  -- Soft delete expiry
  purge_at TIMESTAMPTZ,

  CONSTRAINT chk_valid_to CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- Fixed: Removed NOW() from WHERE clause
CREATE INDEX idx_entity_current ON entity(id) WHERE valid_to IS NULL;
CREATE INDEX idx_entity_tenant_type ON entity(tenant_id, entity_type);
CREATE INDEX idx_entity_owner ON entity(owner_id);
CREATE INDEX idx_entity_status ON entity(status);
CREATE INDEX idx_entity_visibility ON entity(visibility);
CREATE INDEX idx_entity_tags ON entity USING GIN(tags);
CREATE INDEX idx_entity_deleted ON entity(deleted_at);

-- ============================================================================
-- RELATIONSHIP SYSTEM
-- ============================================================================

CREATE TABLE relationship (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,

  -- Source and target entities
  source_id UUID NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES entity(id) ON DELETE CASCADE,

  -- Relationship metadata
  relationship_type VARCHAR(50) NOT NULL, -- 'depends_on', 'part_of', 'derived_from', 'suggests'
  strength DECIMAL(3,2) DEFAULT 1.0, -- 0.0 to 1.0 for weighted relationships
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES "user"(id) ON DELETE SET NULL,

  UNIQUE(source_id, target_id, relationship_type)
);

CREATE INDEX idx_relationship_source ON relationship(source_id, relationship_type);
CREATE INDEX idx_relationship_target ON relationship(target_id, relationship_type);
CREATE INDEX idx_relationship_tenant ON relationship(tenant_id);

-- ============================================================================
-- EVENT SOURCING (Partitioned by month)
-- ============================================================================

CREATE TABLE event (
  id UUID DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,

  -- Event classification
  event_type VARCHAR(100) NOT NULL, -- 'entity.created', 'entity.updated', 'relationship.added', etc.
  aggregate_type VARCHAR(50) NOT NULL, -- 'entity', 'user', 'relationship'
  aggregate_id UUID NOT NULL,

  -- Event payload
  payload JSONB NOT NULL,
  metadata JSONB DEFAULT '{}',

  -- Actor
  actor_id UUID REFERENCES "user"(id) ON DELETE SET NULL,

  -- Timestamp
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- For event replay ordering
  sequence_number BIGSERIAL,

  -- Primary key must include partition column
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Create partitions for current and next 12 months
CREATE TABLE event_2025_01 PARTITION OF event
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE event_2025_02 PARTITION OF event
  FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE event_2025_03 PARTITION OF event
  FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
CREATE TABLE event_2025_04 PARTITION OF event
  FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');
CREATE TABLE event_2025_05 PARTITION OF event
  FOR VALUES FROM ('2025-05-01') TO ('2025-06-01');
CREATE TABLE event_2025_06 PARTITION OF event
  FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
CREATE TABLE event_2025_07 PARTITION OF event
  FOR VALUES FROM ('2025-07-01') TO ('2025-08-01');
CREATE TABLE event_2025_08 PARTITION OF event
  FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE event_2025_09 PARTITION OF event
  FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE event_2025_10 PARTITION OF event
  FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE event_2025_11 PARTITION OF event
  FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE event_2025_12 PARTITION OF event
  FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');

CREATE INDEX idx_event_aggregate ON event(aggregate_type, aggregate_id, occurred_at);
CREATE INDEX idx_event_type ON event(event_type, occurred_at);
CREATE INDEX idx_event_tenant ON event(tenant_id, occurred_at);
CREATE INDEX idx_event_sequence ON event(sequence_number);

-- ============================================================================
-- USAGE TRACKING (Partitioned by day for analytics)
-- ============================================================================

CREATE TABLE usage_event (
  id UUID DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id UUID REFERENCES "user"(id) ON DELETE SET NULL,
  entity_id UUID REFERENCES entity(id) ON DELETE SET NULL,

  -- Usage metrics
  event_type VARCHAR(100) NOT NULL, -- 'api.call', 'entity.view', 'search.query', etc.
  tokens_used INTEGER DEFAULT 0,
  cost_usd DECIMAL(10, 6) DEFAULT 0,
  duration_ms INTEGER,

  -- Context
  metadata JSONB DEFAULT '{}',

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Primary key must include partition column
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Create partitions for current and next 30 days
CREATE TABLE usage_event_2025_01_19 PARTITION OF usage_event
  FOR VALUES FROM ('2025-01-19') TO ('2025-01-20');
CREATE TABLE usage_event_2025_01_20 PARTITION OF usage_event
  FOR VALUES FROM ('2025-01-20') TO ('2025-01-21');
-- Note: In production, use pg_partman or similar for automatic partition management

CREATE INDEX idx_usage_tenant_time ON usage_event(tenant_id, occurred_at);
CREATE INDEX idx_usage_user_time ON usage_event(user_id, occurred_at);
CREATE INDEX idx_usage_entity ON usage_event(entity_id);
CREATE INDEX idx_usage_type ON usage_event(event_type, occurred_at);

-- ============================================================================
-- VECTOR EMBEDDINGS (Semantic Search)
-- ============================================================================

CREATE TABLE embedding (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entity(id) ON DELETE CASCADE,

  -- Embedding metadata
  model VARCHAR(100) NOT NULL, -- 'text-embedding-ada-002', 'all-MiniLM-L6-v2', etc.
  content_hash VARCHAR(64) NOT NULL, -- SHA256 of embedded content

  -- Vector data (1536 dimensions for OpenAI ada-002)
  vector vector(1536) NOT NULL,

  -- Status tracking
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, completed, failed
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(entity_id, model)
);

-- Fixed: Removed NOW() comparison from WHERE clause
CREATE INDEX idx_embedding_entity ON embedding(entity_id);
CREATE INDEX idx_embedding_tenant ON embedding(tenant_id);
CREATE INDEX idx_embedding_status ON embedding(status);
CREATE INDEX idx_embedding_vector ON embedding USING ivfflat (vector vector_cosine_ops) WITH (lists = 100);

-- ============================================================================
-- USER INTERACTIONS
-- ============================================================================

CREATE TABLE favorite (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, entity_id)
);

CREATE INDEX idx_favorite_user ON favorite(user_id);
CREATE INDEX idx_favorite_entity ON favorite(entity_id);

CREATE TABLE share (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_id UUID NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  shared_by UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  shared_with UUID REFERENCES "user"(id) ON DELETE CASCADE, -- NULL = public share

  -- Share settings
  permission VARCHAR(50) NOT NULL DEFAULT 'view', -- view, comment, edit
  expires_at TIMESTAMPTZ,
  share_token VARCHAR(64) UNIQUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accessed_at TIMESTAMPTZ
);

CREATE INDEX idx_share_entity ON share(entity_id);
CREATE INDEX idx_share_token ON share(share_token);
CREATE INDEX idx_share_with ON share(shared_with);

CREATE TABLE suggestion (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- What is being suggested
  suggested_entity_id UUID NOT NULL REFERENCES entity(id) ON DELETE CASCADE,

  -- Context for suggestion
  context_entity_id UUID REFERENCES entity(id) ON DELETE CASCADE,
  suggestion_type VARCHAR(50) NOT NULL, -- 'semantic_match', 'usage_pattern', 'collaborative_filter'
  score DECIMAL(5,4) NOT NULL, -- 0.0 to 1.0
  reason TEXT,

  -- User feedback
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, accepted, rejected, dismissed
  feedback_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fixed: Removed NOW() comparison from WHERE clause
CREATE INDEX idx_suggestion_user_pending ON suggestion(user_id, status);
CREATE INDEX idx_suggestion_entity ON suggestion(suggested_entity_id);
CREATE INDEX idx_suggestion_score ON suggestion(score DESC);

-- ============================================================================
-- READ MODEL (CQRS - Materialized Views)
-- ============================================================================

-- Entity statistics (denormalized for performance)
CREATE MATERIALIZED VIEW entity_stats AS
SELECT
  e.id as entity_id,
  e.entity_type,
  e.tenant_id,
  e.owner_id,
  COUNT(DISTINCT f.id) as favorite_count,
  COUNT(DISTINCT s.id) as share_count,
  COUNT(DISTINCT r_out.id) as outgoing_relationship_count,
  COUNT(DISTINCT r_in.id) as incoming_relationship_count,
  COUNT(DISTINCT ue.id) FILTER (WHERE ue.occurred_at > NOW() - INTERVAL '30 days') as usage_last_30d,
  MAX(ue.occurred_at) as last_used_at
FROM entity e
LEFT JOIN favorite f ON e.id = f.entity_id
LEFT JOIN share s ON e.id = s.entity_id
LEFT JOIN relationship r_out ON e.id = r_out.source_id
LEFT JOIN relationship r_in ON e.id = r_in.target_id
LEFT JOIN usage_event ue ON e.id = ue.entity_id
WHERE e.valid_to IS NULL AND e.deleted_at IS NULL
GROUP BY e.id, e.entity_type, e.tenant_id, e.owner_id;

CREATE UNIQUE INDEX idx_entity_stats_id ON entity_stats(entity_id);
CREATE INDEX idx_entity_stats_tenant ON entity_stats(tenant_id);
CREATE INDEX idx_entity_stats_popular ON entity_stats(favorite_count DESC, usage_last_30d DESC);

-- Tenant usage summary (for billing and quotas)
CREATE MATERIALIZED VIEW tenant_usage_summary AS
SELECT
  t.id as tenant_id,
  t.name as tenant_name,
  COUNT(DISTINCT u.id) as user_count,
  COUNT(DISTINCT e.id) FILTER (WHERE e.deleted_at IS NULL) as active_entity_count,
  COUNT(DISTINCT e.id) FILTER (WHERE e.entity_type = 'context') as context_count,
  COUNT(DISTINCT e.id) FILTER (WHERE e.entity_type = 'template') as template_count,
  COUNT(DISTINCT e.id) FILTER (WHERE e.entity_type = 'workflow') as workflow_count,
  COALESCE(SUM(ue.tokens_used) FILTER (WHERE ue.occurred_at > NOW() - INTERVAL '30 days'), 0) as tokens_last_30d,
  COALESCE(SUM(ue.cost_usd) FILTER (WHERE ue.occurred_at > NOW() - INTERVAL '30 days'), 0) as cost_last_30d
FROM tenant t
LEFT JOIN "user" u ON t.id = u.tenant_id
LEFT JOIN entity e ON t.id = e.tenant_id AND e.valid_to IS NULL
LEFT JOIN usage_event ue ON t.id = ue.tenant_id
GROUP BY t.id, t.name;

CREATE UNIQUE INDEX idx_tenant_usage_id ON tenant_usage_summary(tenant_id);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Semantic search using vector similarity
CREATE OR REPLACE FUNCTION search_similar_entities(
  p_tenant_id UUID,
  p_query_vector vector(1536),
  p_entity_type VARCHAR DEFAULT NULL,
  p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  entity_id UUID,
  title VARCHAR,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.title,
    1 - (emb.vector <=> p_query_vector) as similarity
  FROM embedding emb
  JOIN entity e ON emb.entity_id = e.id
  WHERE
    e.tenant_id = p_tenant_id
    AND e.valid_to IS NULL
    AND e.deleted_at IS NULL
    AND (p_entity_type IS NULL OR e.entity_type = p_entity_type)
    AND emb.status = 'completed'
  ORDER BY emb.vector <=> p_query_vector
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- Get entity with all its relationships
CREATE OR REPLACE FUNCTION get_entity_graph(
  p_entity_id UUID,
  p_depth INTEGER DEFAULT 1
)
RETURNS TABLE (
  entity_id UUID,
  entity_type VARCHAR,
  title VARCHAR,
  relationship_type VARCHAR,
  depth INTEGER
) AS $$
WITH RECURSIVE entity_graph AS (
  -- Base case: the starting entity
  SELECT
    e.id as entity_id,
    e.entity_type,
    e.title,
    NULL::VARCHAR as relationship_type,
    0 as depth
  FROM entity e
  WHERE e.id = p_entity_id AND e.valid_to IS NULL

  UNION ALL

  -- Recursive case: entities connected by relationships
  SELECT
    e.id,
    e.entity_type,
    e.title,
    r.relationship_type,
    eg.depth + 1
  FROM entity_graph eg
  JOIN relationship r ON eg.entity_id = r.source_id
  JOIN entity e ON r.target_id = e.id
  WHERE eg.depth < p_depth AND e.valid_to IS NULL AND e.deleted_at IS NULL
)
SELECT * FROM entity_graph;
$$ LANGUAGE sql STABLE;

-- Get entity version history
CREATE OR REPLACE FUNCTION get_entity_history(p_entity_id UUID)
RETURNS TABLE (
  version INTEGER,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  title VARCHAR,
  content JSONB,
  updated_by UUID
) AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE version_chain AS (
    -- Get current version
    SELECT
      e.id,
      e.version,
      e.valid_from,
      e.valid_to,
      e.title,
      e.content,
      e.owner_id as updated_by,
      e.previous_version_id
    FROM entity e
    WHERE e.id = p_entity_id

    UNION ALL

    -- Get previous versions
    SELECT
      e.id,
      e.version,
      e.valid_from,
      e.valid_to,
      e.title,
      e.content,
      e.owner_id,
      e.previous_version_id
    FROM entity e
    JOIN version_chain vc ON e.id = vc.previous_version_id
  )
  SELECT
    vc.version,
    vc.valid_from,
    vc.valid_to,
    vc.title,
    vc.content,
    vc.updated_by
  FROM version_chain vc
  ORDER BY vc.version DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- MAINTENANCE FUNCTIONS
-- ============================================================================

-- Refresh materialized views (call this periodically or via cron)
CREATE OR REPLACE FUNCTION refresh_read_model()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY entity_stats;
  REFRESH MATERIALIZED VIEW CONCURRENTLY tenant_usage_summary;
END;
$$ LANGUAGE plpgsql;

-- Purge soft-deleted entities past their expiry date
CREATE OR REPLACE FUNCTION purge_expired_entities()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM entity
    WHERE deleted_at IS NOT NULL
      AND purge_at IS NOT NULL
      AND purge_at < NOW()
    RETURNING id
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted;

  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SAMPLE QUERIES
-- ============================================================================

-- Example 1: Get all active contexts for a user
/*
SELECT
  e.id,
  e.title,
  e.description,
  e.content,
  es.favorite_count,
  es.usage_last_30d
FROM entity e
LEFT JOIN entity_stats es ON e.id = es.entity_id
WHERE
  e.owner_id = 'USER_UUID'
  AND e.entity_type = 'context'
  AND e.valid_to IS NULL
  AND e.deleted_at IS NULL
  AND e.status = 'published'
ORDER BY es.usage_last_30d DESC, e.created_at DESC;
*/

-- Example 2: Search for similar contexts using embeddings
/*
SELECT * FROM search_similar_entities(
  'TENANT_UUID',
  (SELECT vector FROM embedding WHERE entity_id = 'QUERY_ENTITY_ID' LIMIT 1),
  'context',
  10
);
*/

-- Example 3: Get template with all its context dependencies
/*
SELECT * FROM get_entity_graph('TEMPLATE_UUID', 2);
*/

-- Example 4: Get version history of an entity
/*
SELECT * FROM get_entity_history('ENTITY_UUID');
*/

-- Example 5: Complex search with filters
/*
SELECT
  e.id,
  e.title,
  e.entity_type,
  e.created_at,
  es.favorite_count,
  es.usage_last_30d,
  1 - (emb.vector <=> query_vec.vector) as similarity
FROM entity e
JOIN embedding emb ON e.id = emb.entity_id
CROSS JOIN (SELECT vector FROM embedding WHERE entity_id = 'QUERY_ID' LIMIT 1) query_vec
LEFT JOIN entity_stats es ON e.id = es.entity_id
WHERE
  e.tenant_id = 'TENANT_UUID'
  AND e.valid_to IS NULL
  AND e.deleted_at IS NULL
  AND e.entity_type IN ('context', 'template')
  AND e.tags && ARRAY['tag1', 'tag2']
  AND emb.status = 'completed'
ORDER BY
  (1 - (emb.vector <=> query_vec.vector)) DESC,
  es.usage_last_30d DESC
LIMIT 20;
*/

-- ============================================================================
-- NOTES
-- ============================================================================

/*
DESIGN DECISIONS:

1. **Temporal Versioning**: Every entity has valid_from/valid_to for complete history.
   - Current version: valid_to IS NULL
   - Historical versions: valid_to IS NOT NULL
   - Enables time-travel queries and audit trails

2. **Event Sourcing**: All state changes recorded in event table.
   - Partitioned by month for performance
   - Enables event replay, debugging, and analytics
   - Separates write model (events) from read model (materialized views)

3. **Universal Entity Table**: Single table for all content types.
   - Reduces table sprawl (87 tables → ~20 tables)
   - Simplifies relationships, favorites, sharing, search
   - Type-specific data in JSONB content field
   - Critical fields normalized for query performance

4. **Materialized Views**: Denormalized read model for performance.
   - entity_stats: Pre-computed counts and metrics
   - tenant_usage_summary: Billing and quota tracking
   - Refresh periodically (cron job or trigger-based)

5. **Partitioning**: Hot tables partitioned for scalability.
   - event: Partitioned by month
   - usage_event: Partitioned by day
   - Enables fast queries on recent data and easy archival

6. **Vector Search**: pgvector for semantic similarity.
   - Separate embedding table with status tracking
   - IVFFlat index for fast approximate nearest neighbor
   - Supports multiple embedding models per entity

7. **No Triggers on Hot Path**: All computed values in materialized views.
   - Prevents write amplification
   - Better for high-volume workloads
   - Eventual consistency acceptable for stats

8. **Soft Deletes**: deleted_at + purge_at for safety.
   - Users can recover accidentally deleted items
   - Automated cleanup of old deleted items
   - Maintains referential integrity during recovery window

9. **Multi-Tenancy**: tenant_id on all relevant tables.
   - Ready for Row-Level Security (RLS) policies
   - Enables tenant isolation and data segregation
   - Single database, multiple tenants

10. **Immutability Compliance**: All index predicates use immutable functions only.
    - Removed NOW() from partial index WHERE clauses
    - Simple predicates on nullable columns (IS NULL, status values)
    - Performance optimized without violating PostgreSQL constraints

MIGRATION STRATEGY:

Phase 1: Create new schema alongside old schema
Phase 2: Build ETL pipeline to migrate data
Phase 3: Run dual-write (write to both schemas)
Phase 4: Verify data consistency
Phase 5: Switch reads to new schema
Phase 6: Stop dual-write, decommission old schema

PERFORMANCE CONSIDERATIONS:

- Partition pruning on event/usage_event for time-range queries
- Materialized views updated hourly/daily via cron
- Vector index lists=100 is good for up to 1M vectors (adjust as needed)
- Consider pg_partman for automatic partition management
- Consider TimescaleDB for usage_event if analytics becomes complex

FUTURE ENHANCEMENTS:

- Row-Level Security policies for tenant isolation
- Full-text search indexes on title/description
- GraphQL schema generation from this structure
- Redis caching layer for materialized view data
- Separate read replicas for analytics queries
*/
