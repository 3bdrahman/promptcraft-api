# Enterprise Database Schema

This directory contains the next-generation database schema for PromptCraft, designed to replace the current 87-table schema with a clean, scalable, enterprise-grade design.

## Overview

The new schema reduces complexity from **87 tables to ~20 core tables** while supporting all current features and enabling future growth.

### Key Features

1. **Temporal Versioning** - Complete version history for all entities
2. **Event Sourcing + CQRS** - Audit trail and scalability through separation of write/read models
3. **Partitioning** - Time-based partitioning for high-volume tables
4. **Vector Search** - Semantic search using pgvector
5. **Multi-Tenancy Ready** - Built-in tenant isolation
6. **Materialized Views** - Optimized read model for performance
7. **No Triggers on Hot Path** - Better write performance

## Schema Structure

### Core Tables

| Table | Purpose | Partitioned |
|-------|---------|-------------|
| `tenant` | Multi-tenant isolation | No |
| `user` | User accounts | No |
| `session` | Authentication sessions | No |
| `entity` | Universal content table (contexts, templates, workflows, libraries) | No |
| `relationship` | Connections between entities | No |
| `event` | Event sourcing log | Yes (by month) |
| `usage_event` | Analytics and billing | Yes (by day) |
| `embedding` | Vector embeddings for semantic search | No |
| `favorite` | User favorites | No |
| `share` | Sharing and permissions | No |
| `suggestion` | AI-powered recommendations | No |

### Read Model (Materialized Views)

| View | Purpose | Refresh Strategy |
|------|---------|------------------|
| `entity_stats` | Aggregated entity metrics | Hourly/Daily |
| `tenant_usage_summary` | Billing and quota tracking | Daily |

## Installation

### Prerequisites

```bash
# Ensure PostgreSQL 15+ with required extensions
psql -d your_database -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql -d your_database -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"
psql -d your_database -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

### Apply Schema

```bash
# From the promptcraft-api repository
psql -d your_database -f /path/to/craft-site/schema/enterprise-schema.sql
```

## Design Principles

### 1. Universal Entity Table

Instead of separate tables for contexts, templates, workflows, etc., we use a single `entity` table with an `entity_type` discriminator.

**Benefits:**
- Simpler relationships (one relationship table instead of many)
- Universal favoriting, sharing, search
- Easier to add new content types
- Reduced JOIN complexity

**Structure:**
```sql
entity (
  id, entity_type, -- 'context', 'template', 'workflow', 'library'
  title, description, status, visibility,
  content JSONB, -- Type-specific fields
  tags[], metadata JSONB,
  version, valid_from, valid_to -- Temporal versioning
)
```

### 2. Temporal Versioning

Every entity has complete version history using the SQL:2011 temporal pattern:

- **Current version**: `valid_to IS NULL`
- **Historical versions**: `valid_to IS NOT NULL`
- **Previous version link**: `previous_version_id`

**Benefits:**
- Time-travel queries ("show me this template as it was on March 1st")
- Complete audit trail
- Easy rollback
- Compare versions

**Example Query:**
```sql
-- Get current version
SELECT * FROM entity WHERE id = 'ENTITY_ID' AND valid_to IS NULL;

-- Get version history
SELECT * FROM get_entity_history('ENTITY_ID');

-- Get version at specific time
SELECT * FROM entity
WHERE id = 'ENTITY_ID'
  AND valid_from <= '2025-03-01'
  AND (valid_to IS NULL OR valid_to > '2025-03-01');
```

### 3. Event Sourcing + CQRS

**Write Model (Command):**
- All state changes recorded in `event` table
- Partitioned by month for performance
- Immutable log of everything that happened

**Read Model (Query):**
- Materialized views (`entity_stats`, `tenant_usage_summary`)
- Optimized for queries, not writes
- Refreshed periodically (eventual consistency)

**Benefits:**
- Complete audit trail
- Event replay for debugging
- Scalability through read/write separation
- Analytics-friendly

### 4. Partitioning Strategy

**Event Table** (partitioned by month):
```sql
event
├── event_2025_01
├── event_2025_02
├── event_2025_03
└── ...
```

**Usage Event Table** (partitioned by day):
```sql
usage_event
├── usage_event_2025_01_19
├── usage_event_2025_01_20
└── ...
```

**Benefits:**
- Fast queries on recent data (partition pruning)
- Easy archival of old data
- Better vacuum/analyze performance
- Horizontal scalability

**Note:** Use `pg_partman` extension for automatic partition management in production.

### 5. Vector Search

Uses pgvector extension for semantic similarity search:

```sql
embedding (
  entity_id,
  model, -- 'text-embedding-ada-002', etc.
  vector vector(1536),
  status -- 'pending', 'completed', 'failed'
)
```

**Example Search:**
```sql
SELECT * FROM search_similar_entities(
  'TENANT_ID',
  (SELECT vector FROM embedding WHERE entity_id = 'QUERY_ID' LIMIT 1),
  'context',
  10 -- limit
);
```

### 6. Relationship System

Universal relationship table supports any entity-to-entity connection:

```sql
relationship (
  source_id, target_id,
  relationship_type, -- 'depends_on', 'part_of', 'derived_from', 'suggests'
  strength, -- 0.0 to 1.0 for weighted relationships
  metadata JSONB
)
```

**Examples:**
- Template depends on Context: `template_id -> context_id` (type: 'depends_on')
- Context part of Library: `context_id -> library_id` (type: 'part_of')
- Template derived from Template: `new_template_id -> original_template_id` (type: 'derived_from')
- AI suggests Context: `context_id -> suggested_context_id` (type: 'suggests', strength: 0.85)

**Get Relationship Graph:**
```sql
SELECT * FROM get_entity_graph('ENTITY_ID', 2); -- depth = 2
```

## Supported Features

This schema supports all current PromptCraft features:

### ✅ Core Features
- [x] User authentication (JWT + OAuth)
- [x] Multi-tenancy
- [x] Contexts (create, edit, version, delete)
- [x] Templates (create, edit, version, delete)
- [x] Workflows (stored as entity type 'workflow')
- [x] Libraries (stored as entity type 'library')

### ✅ Advanced Features
- [x] Version history and rollback
- [x] Template-context dependencies
- [x] Context composition (via relationships)
- [x] Favorites
- [x] Sharing (with permissions and expiry)
- [x] Tags and search
- [x] Semantic search (vector embeddings)
- [x] AI recommendations
- [x] Usage tracking and analytics
- [x] Compression analytics (in metadata JSONB)
- [x] Auto-composition tracking (in metadata JSONB)

### ✅ Enterprise Features
- [x] Complete audit trail (event sourcing)
- [x] Time-travel queries (temporal versioning)
- [x] Soft deletes with recovery
- [x] Multi-tenant isolation
- [x] Horizontal scalability (partitioning)
- [x] Read/write separation (CQRS)

## Migration Strategy

### Phase 1: Parallel Schema (1-2 weeks)
1. Create new schema in same database
2. Update application to read from old schema (no changes yet)
3. Test new schema with sample data

### Phase 2: ETL Pipeline (2-3 weeks)
```sql
-- Example: Migrate contexts to entity table
INSERT INTO entity (id, entity_type, tenant_id, owner_id, title, description, content, created_at, updated_at)
SELECT
  id,
  'context' as entity_type,
  tenant_id,
  user_id as owner_id,
  title,
  description,
  jsonb_build_object(
    'prompt', prompt,
    'variables', variables,
    'examples', examples
  ) as content,
  created_at,
  updated_at
FROM old_context_table;

-- Migrate relationships
INSERT INTO relationship (source_id, target_id, relationship_type, created_at)
SELECT
  template_id as source_id,
  context_id as target_id,
  'depends_on' as relationship_type,
  created_at
FROM old_template_context_table;
```

### Phase 3: Dual-Write (1 week)
1. Application writes to both old and new schema
2. Verify data consistency
3. Monitor for discrepancies

### Phase 4: Switch Reads (1 week)
1. Gradually switch read queries to new schema
2. Monitor performance
3. Keep old schema as fallback

### Phase 5: Decommission (1 week)
1. Stop writing to old schema
2. Final data consistency check
3. Drop old tables (after backup!)

**Total Migration Time: 6-8 weeks**

## Performance Optimization

### Indexing Strategy

The schema includes optimized indexes for common queries:

- **Entity lookups**: `idx_entity_current` (partial index on current versions)
- **Tenant filtering**: `idx_entity_tenant_type`
- **Tag search**: `idx_entity_tags` (GIN index)
- **Vector search**: `idx_embedding_vector` (IVFFlat index)
- **Relationship traversal**: `idx_relationship_source`, `idx_relationship_target`

### Materialized View Refresh

Set up cron job for periodic refresh:

```sql
-- Refresh every hour
SELECT cron.schedule('refresh-stats', '0 * * * *', 'SELECT refresh_read_model()');
```

Or refresh after bulk operations:

```sql
-- After inserting many entities
SELECT refresh_read_model();
```

### Query Performance Tips

1. **Always filter current versions**: `WHERE valid_to IS NULL`
2. **Use materialized views for stats**: Query `entity_stats` instead of computing on the fly
3. **Leverage partition pruning**: Filter by time range on event/usage tables
4. **Use semantic search function**: `search_similar_entities()` is optimized
5. **Batch operations**: Use `INSERT ... SELECT` for bulk data

## Monitoring

### Key Metrics

```sql
-- Check partition sizes
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE tablename LIKE 'event_%' OR tablename LIKE 'usage_event_%'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Check materialized view freshness
SELECT
  schemaname,
  matviewname,
  last_refresh
FROM pg_matviews
WHERE schemaname = 'public';

-- Check embedding processing status
SELECT
  status,
  COUNT(*) as count
FROM embedding
GROUP BY status;

-- Top tenants by usage
SELECT * FROM tenant_usage_summary ORDER BY tokens_last_30d DESC LIMIT 10;
```

## Troubleshooting

### "relation does not exist" error
Make sure you've created the required PostgreSQL extensions:
```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
```

### Slow queries on entity table
- Ensure you're filtering by `valid_to IS NULL` for current versions
- Check that indexes are being used: `EXPLAIN ANALYZE your_query`
- Consider refreshing table statistics: `ANALYZE entity;`

### Vector search not working
- Verify pgvector extension is installed: `SELECT * FROM pg_extension WHERE extname = 'vector';`
- Ensure embeddings are in 'completed' status
- Adjust IVFFlat lists parameter based on data size (current: 100 for ~1M vectors)

### Partition management
- Use `pg_partman` extension for automatic partition creation
- Set up retention policy to archive/drop old partitions
- Monitor partition sizes to ensure even distribution

## Future Enhancements

### Row-Level Security (RLS)
```sql
ALTER TABLE entity ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON entity
  USING (tenant_id = current_setting('app.current_tenant')::uuid);
```

### Full-Text Search
```sql
ALTER TABLE entity ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX idx_entity_search ON entity USING GIN(search_vector);
```

### Read Replicas
- Set up streaming replication for read replicas
- Route analytics queries to replicas
- Use connection pooler (PgBouncer) for connection management

### Caching Layer
- Redis for materialized view data
- Cache frequently accessed entities
- Invalidate on writes via event triggers

## Questions?

For implementation questions or schema modification proposals, please:

1. Review the inline SQL comments in `enterprise-schema.sql`
2. Check the sample queries at the end of the schema file
3. Consult PostgreSQL documentation for advanced features
4. Open an issue for discussion

## License

This schema is part of the PromptCraft project.
