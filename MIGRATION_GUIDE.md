# PromptCraft API - Enterprise Schema Migration Guide

## Overview

This document describes the migration from the old database schema to the new enterprise-grade schema. The new schema implements industry best practices including:

- **Temporal Versioning**: Complete version history with SQL:2011 temporal patterns
- **Event Sourcing + CQRS**: Audit trail and scalability via event log
- **Universal Entity Table**: Single table for all content types (contexts, templates, workflows)
- **Multi-Tenancy**: Tenant isolation for enterprise deployments
- **Partitioning**: Hot tables partitioned for performance
- **Vector Search**: Unified embedding table with pgvector
- **Materialized Views**: Denormalized read model for analytics

## Schema Changes

### Core Table Mappings

| Old Schema | New Schema | Notes |
|------------|------------|-------|
| `users` | `user` + `tenant` | Multi-tenancy support |
| `templates` | `entity` (entity_type='template') | Universal entity table |
| `context_layers` | `entity` (entity_type='context') | Universal entity table |
| `workflows` | `entity` (entity_type='workflow') | Universal entity table |
| `template_versions` | `entity` versioning | Temporal versioning built-in |
| `context_versions` | `entity` versioning | Temporal versioning built-in |
| `user_favorites` | `favorite` | Unified favorites table |
| `context_embeddings` | `embedding` | Unified embeddings with pgvector |
| `template_embeddings` | `embedding` | Unified embeddings with pgvector |
| `context_relationships` | `relationship` | Unified relationships |
| `refresh_tokens` | `session` | Authentication sessions |
| `audit_logs` | `event` | Event sourcing (partitioned) |
| `*_usage_*` tables | `usage_event` | Unified usage tracking (partitioned) |

### Column Mappings (Entity Table)

| Old Column | New Location | Notes |
|------------|--------------|-------|
| `name` | `title` | Direct column |
| `description` | `description` | Direct column |
| `content` | `content` (JSONB) | Stored as `{text: "..."}` |
| `layer_type` | `metadata.layer_type` | JSONB field |
| `category` | `metadata.category` | JSONB field |
| `variables` | `metadata.variables` | JSONB field |
| `is_template` | `metadata.is_template` | JSONB field |
| `team_id` | `metadata.team_id` | JSONB field |
| `visibility` | `visibility` | Direct column (private/shared/public) |
| `tags` | `tags` | Array type |
| `user_id` | `owner_id` | Foreign key to user table |

## Updated Files

### Core Infrastructure

1. **`src/utils/database.js`** - ✅ UPDATED
   - Added helper functions for entity CRUD operations
   - Added event logging and usage tracking
   - Added tenant management
   - Functions: `createEntity()`, `updateEntity()`, `deleteEntity()`, `getCurrentEntity()`, `ensureTenant()`, `logEvent()`, `trackUsage()`

### Handler Files

2. **`src/routes/handlers/layers.js`** - ✅ UPDATED
   - Migrated from `context_layers` to `entity` table
   - Uses temporal versioning
   - Maps responses to old format for backward compatibility
   - Added event logging for all mutations

3. **`src/routes/handlers/templates.js`** - ✅ UPDATED
   - Migrated from `templates` to `entity` table
   - Uses `favorite` table instead of `user_favorites`
   - Uses `relationship` table for dependencies
   - Added comprehensive event logging
   - Backward compatible response mapping

4. **`src/routes/handlers/workflows.js`** - ✅ UPDATED
   - Migrated from `workflows` to `entity` table
   - Execution history stored in `usage_event` table
   - Workflow config stored in `content` JSONB field
   - Added event logging for executions

5. **`src/routes/handlers/contexts/semantic_search.js`** - ✅ UPDATED
   - Uses unified `embedding` table
   - Leverages `search_similar_entities()` function
   - Updated vector dimension handling (1536 for enterprise schema)
   - Filters by `entity_type`, `valid_to IS NULL`, `deleted_at IS NULL`

6. **`src/routes/handlers/templates/search.js`** - ✅ UPDATED
   - Uses unified `embedding` table
   - Supports both authenticated and public searches
   - Updated embedding generation and storage
   - Backward compatible response format

## Key Features Implemented

### 1. Temporal Versioning

Every entity update creates a new version automatically:

```javascript
// Old approach
UPDATE templates SET content = $1 WHERE id = $2;

// New approach (via updateEntity helper)
const updated = await updateEntity(entityId, { content: { text: newContent } }, userId);
// This automatically:
// - Closes the current version (sets valid_to = NOW())
// - Creates a new version with incremented version number
// - Links to previous version via previous_version_id
```

### 2. Event Sourcing

All mutations are logged to the event table:

```javascript
await logEvent({
  tenantId,
  eventType: 'entity.created',
  aggregateType: 'entity',
  aggregateId: entity.id,
  actorId: userId,
  payload: { entityType: 'template', category }
});
```

Event types include:
- `entity.created`, `entity.updated`, `entity.deleted`
- `template.favorited`, `template.unfavorited`
- `template.shared`, `template.unshared`
- `workflow.executed`
- Custom domain events

### 3. Usage Tracking

Unified usage tracking via `usage_event` table:

```javascript
await trackUsage({
  tenantId,
  userId,
  entityId,
  eventType: 'entity.used',
  tokensUsed: 1500,
  costUsd: 0.002,
  durationMs: 450,
  metadata: { context: 'additional info' }
});
```

### 4. Multi-Tenancy

All operations ensure tenant isolation:

```javascript
const tenantId = await ensureTenant(userId);
// All queries filter by tenant_id for proper isolation
```

### 5. Soft Deletes with Purge Dates

```javascript
await deleteEntity(entityId, userId);
// Sets deleted_at = NOW() and purge_at = NOW() + 30 days
// Can be recovered within 30 days, then auto-purged
```

## Backward Compatibility

All updated handlers maintain backward compatibility by:

1. **Response Mapping**: Entity rows are mapped back to old format
   ```javascript
   const layer = {
     id: entity.id,
     user_id: entity.owner_id,
     name: entity.title,
     description: entity.description,
     content: entity.content.text,
     layer_type: entity.metadata.layer_type,
     // ... etc
   };
   ```

2. **Query Parameter Support**: Old query parameters still work
   - `type` maps to `metadata.layer_type`
   - `is_template` maps to `metadata.is_template`
   - All existing filters preserved

3. **Endpoint Compatibility**: All existing endpoints work without changes
   - GET /api/contexts/layers - still works
   - POST /api/templates - still works
   - PUT /api/workflows/:id - still works

## Database Schema Setup

To use the new schema, apply the enterprise schema:

```sql
-- Run the enterprise schema
\i schema/enterprise-schema.sql
```

This creates:
- All core tables (tenant, user, entity, relationship, etc.)
- Partitioned tables (event, usage_event)
- Materialized views (entity_stats, tenant_usage_summary)
- Helper functions (search_similar_entities, get_entity_history, get_entity_graph)
- Indexes for performance

## Remaining Work

The following handlers still need to be updated to use the new schema:

### ✅ Completed
- [x] `src/routes/handlers/auth/*.js` - ✅ Updated to use new `session` table and event sourcing
- [x] `src/routes/handlers/user.js` - ✅ Updated for new user table with event logging

### High Priority
- [ ] `src/routes/handlers/contexts/composition.js` - Use `relationship` table
- [ ] `src/routes/handlers/contexts/relationships.js` - Use `relationship` table
- [ ] `src/routes/handlers/contexts/versions.js` - Use temporal versioning
- [ ] `src/routes/handlers/teams/*.js` - Update for new schema
- [ ] `src/routes/handlers/analytics.js` - Use materialized views
- [ ] `src/routes/handlers/subscription.js` - Update for tenant-based limits

### Medium Priority
- [ ] `src/routes/handlers/snippets.js` - Migrate to entity table
- [ ] `src/routes/handlers/combinations.js` - Use relationship table
- [ ] `src/routes/handlers/contexts/compression.js` - Update storage
- [ ] `src/routes/handlers/contexts/conversational_builder.js` - Update storage
- [ ] `src/routes/handlers/contexts/predictive.js` - Use usage_event table
- [ ] `src/routes/handlers/contexts/ai_recommendations.js` - Use entity_stats view

### Low Priority
- [ ] `src/routes/handlers/profiles.js` - Update for new user table
- [ ] `src/routes/handlers/embeddings/queue.js` - Use unified embedding table

## Testing Checklist

After updating each handler, test:

- [ ] **Create**: Can create new entities
- [ ] **Read**: Can retrieve entities with correct format
- [ ] **Update**: Updates create new versions
- [ ] **Delete**: Soft deletes work correctly
- [ ] **List**: Filtering and sorting work
- [ ] **Search**: Semantic search returns results
- [ ] **Versions**: Version history accessible
- [ ] **Permissions**: User isolation enforced
- [ ] **Events**: Mutations logged to event table
- [ ] **Usage**: Usage tracking works

## Migration Strategy

For production deployment:

### Phase 1: Dual Schema (Current)
- New schema deployed alongside old
- New code queries new schema
- Old data remains in old tables
- Backward compatibility maintained

### Phase 2: Data Migration (Next)
- Write migration scripts to copy data from old → new schema
- Map old table rows to entity table
- Generate embeddings for existing content
- Create initial versions for all entities

### Phase 3: Dual Write (Optional)
- Write to both old and new schemas temporarily
- Verify data consistency
- Gradual cutover

### Phase 4: Schema Cutover
- Switch all reads to new schema
- Stop writing to old schema
- Archive old tables

### Phase 5: Cleanup
- Drop old tables after verification period
- Optimize indexes and partitions
- Set up automated partition management (pg_partman)

## Performance Considerations

1. **Materialized View Refresh**
   ```sql
   -- Schedule hourly refresh of materialized views
   REFRESH MATERIALIZED VIEW CONCURRENTLY entity_stats;
   REFRESH MATERIALIZED VIEW CONCURRENTLY tenant_usage_summary;
   ```

2. **Partition Management**
   - Set up pg_partman for automatic partition creation
   - Archive old partitions to separate tablespace
   - Current partitions created through 2025-12

3. **Index Tuning**
   - All critical queries indexed
   - Partial indexes for current versions (valid_to IS NULL)
   - GIN indexes for JSONB fields
   - IVFFlat index for vector similarity

4. **Query Optimization**
   - Always filter by entity_type, valid_to IS NULL, deleted_at IS NULL
   - Use materialized views for aggregate queries
   - Leverage partition pruning for time-range queries

## Troubleshooting

### Common Issues

**Issue**: "relation 'entity' does not exist"
- **Solution**: Run `schema/enterprise-schema.sql`

**Issue**: "column 'valid_to' does not exist"
- **Solution**: Query is hitting old table, update to use `entity`

**Issue**: "vector dimension mismatch"
- **Solution**: Enterprise schema uses 1536 dimensions (OpenAI ada-002), old used 384

**Issue**: "tenant_id cannot be null"
- **Solution**: Call `ensureTenant(userId)` before entity operations

**Issue**: "function search_similar_entities does not exist"
- **Solution**: Run enterprise schema to create helper functions

## Contact & Support

For questions about this migration:
- Review schema: `schema/enterprise-schema.sql`
- Check updated handlers for patterns
- See database.js for helper functions

## Change Log

### 2025-01-19 (Latest)
- ✅ Updated all 7 authentication handlers (login, signup, verify-pin, logout, logout-all, refresh, resend-pin)
- ✅ Migrated from `users` → `"user"` table
- ✅ Migrated from `refresh_tokens` → `session` table
- ✅ Replaced audit_logs with event sourcing via logEvent()
- ✅ Updated user.js handler for profile management
- ✅ Added event logging for all auth operations (user.login, user.logout, user.signup, etc.)
- ✅ Implemented multi-tenancy support in auth flow via ensureTenant()

### 2025-01-19 (Initial)
- ✅ Created enterprise schema (enterprise-schema.sql)
- ✅ Updated database.js with helper functions
- ✅ Migrated layers.js (contexts)
- ✅ Migrated templates.js
- ✅ Migrated workflows.js
- ✅ Migrated semantic search handlers
- ✅ Created migration guide
