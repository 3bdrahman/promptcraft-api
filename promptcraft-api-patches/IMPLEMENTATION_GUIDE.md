# PromptCraft Vector Embeddings Implementation Guide

**Date**: 2025-11-16
**Version**: 1.0
**Author**: PromptCraft Team

---

## Overview

This guide will help you implement **local vector embeddings** for semantic search in the PromptCraft API. All embeddings are generated **locally using Transformers.js** - no external API calls, no cost, complete privacy!

### What You'll Get

✅ **Semantic Search**: Find contexts/templates by meaning, not just keywords
✅ **AI Recommendations**: Smart context suggestions based on usage patterns
✅ **Similar Content Discovery**: Find related templates and contexts automatically
✅ **100% Local**: All processing happens on your server (no OpenAI API calls)
✅ **Fast**: ~50-100ms per embedding on CPU, even faster on GPU
✅ **Cost-Effective**: Zero ongoing costs for embeddings

---

## Prerequisites

### 1. PostgreSQL with pgvector Extension

Your database must support the `pgvector` extension.

**For Neon** (recommended):
- pgvector is pre-installed ✅
- No additional setup needed

**For Supabase**:
```sql
-- Run in SQL Editor
CREATE EXTENSION IF NOT EXISTS vector;
```

**For Self-Hosted PostgreSQL**:
```bash
# Install pgvector
# Ubuntu/Debian
sudo apt install postgresql-16-pgvector

# macOS
brew install pgvector

# Then in psql:
CREATE EXTENSION vector;
```

### 2. Node.js Environment

- Node.js 16+ (ES Modules support)
- Sufficient RAM: 512MB+ available (for model loading)
- Disk space: ~100MB for model cache

---

## Step-by-Step Implementation

### **Step 1: Install Dependencies**

Add the Transformers.js library to your `promptcraft-api` project:

```bash
cd promptcraft-api
npm install @xenova/transformers@^2.17.0
```

Update your `package.json`:

```json
{
  "dependencies": {
    "@xenova/transformers": "^2.17.0",
    // ... existing dependencies
  }
}
```

---

### **Step 2: Add New Service Files**

Copy the new service files from the patches directory:

```bash
# From the promptcraft-api-patches directory
cp services/localEmbeddingService.js ../promptcraft-api/src/services/
cp services/embeddingWorker.js ../promptcraft-api/src/services/
```

**Files added:**
- `src/services/localEmbeddingService.js` - Local embedding generation
- `src/services/embeddingWorker.js` - Background job processor

---

### **Step 3: Run Database Migrations**

Apply the migrations in order:

#### **Migration 1: Setup pgvector Extension & Tables**

```bash
# Connect to your database
psql $DATABASE_URL -f promptcraft-api-patches/migrations/001_setup_pgvector_extension.sql
```

**What this creates:**
- `context_embeddings` table
- `template_embeddings` table
- `embedding_queue` table
- HNSW vector indexes for fast similarity search
- Triggers for auto-queueing embeddings on content changes

**Verify:**
```sql
-- Check tables were created
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('context_embeddings', 'template_embeddings', 'embedding_queue');

-- Check vector extension
SELECT * FROM pg_extension WHERE extname = 'vector';
```

#### **Migration 2: Create Vector Similarity Functions**

```bash
psql $DATABASE_URL -f promptcraft-api-patches/migrations/002_vector_similarity_functions.sql
```

**What this creates:**
- `find_similar_contexts()` - Semantic search for contexts
- `find_similar_templates()` - Semantic search for templates
- `get_learned_recommendations()` - AI-powered recommendations
- `get_context_effectiveness()` - Analytics
- `get_context_associations()` - Frequently paired contexts
- `hybrid_search_contexts()` - Combined text + semantic search

**Verify:**
```sql
-- Check functions were created
SELECT proname FROM pg_proc WHERE proname LIKE 'find_similar%';
```

---

### **Step 4: Update API Handlers**

#### **Option A: Manual Update (Recommended)**

Edit `src/routes/handlers/contexts/search.js`:

Change line 9:
```javascript
// OLD:
import { generateEmbedding } from '../../../services/embeddingService.js';

// NEW:
import { generateEmbedding } from '../../../services/localEmbeddingService.js';
```

Update the `findSimilar` function (around line 146):
```javascript
// OLD:
const contextResult = await db.query(
  `SELECT id, name, embedding
   FROM context_layers
   WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
  [contextId, userId]
);

// NEW:
const contextResult = await db.query(
  `SELECT cl.id, cl.name, ce.embedding
   FROM context_layers cl
   LEFT JOIN context_embeddings ce ON cl.id = ce.context_id
   WHERE cl.id = $1 AND cl.user_id = $2 AND cl.deleted_at IS NULL`,
  [contextId, userId]
);
```

Update the `queueEmbeddingGeneration` function (around line 397):
```javascript
// OLD:
const result = await db.query(
  `INSERT INTO embedding_generation_queue (context_id, priority, status)
   VALUES ($1, $2, 'pending')
   ON CONFLICT (context_id, status)
   DO UPDATE SET priority = $2, attempts = 0
   RETURNING *`,
  [contextId, priority]
);

// NEW:
const result = await db.query(
  `INSERT INTO embedding_queue (resource_type, resource_id, priority, status)
   VALUES ('context', $1, $2, 'pending')
   ON CONFLICT (resource_type, resource_id, status)
   DO UPDATE SET priority = $2
   RETURNING *`,
  [contextId, priority]
);
```

#### **Option B: Apply Patch**

```bash
cd promptcraft-api
git apply ../promptcraft-api-patches/handlers/contexts_search_updated.patch
```

---

### **Step 5: Integrate Embedding Worker into Server**

Edit `src/server.js`:

Add imports at the top:
```javascript
import { startEmbeddingWorker, stopEmbeddingWorker } from './services/embeddingWorker.js';
import { preloadModel } from './services/localEmbeddingService.js';
```

Add initialization code before `app.listen()`:
```javascript
// Preload embedding model on startup (optional but recommended)
if (process.env.PRELOAD_EMBEDDING_MODEL !== 'false') {
  console.log('Preloading embedding model...');
  try {
    await preloadModel();
    console.log('✓ Embedding model preloaded');
  } catch (error) {
    console.warn('⚠ Failed to preload embedding model:', error.message);
  }
}

// Start embedding worker
if (process.env.ENABLE_EMBEDDING_WORKER !== 'false') {
  console.log('Starting embedding worker...');
  await startEmbeddingWorker();
  console.log('✓ Embedding worker started');
}
```

Add graceful shutdown:
```javascript
// Handle shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await stopEmbeddingWorker();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  await stopEmbeddingWorker();
  process.exit(0);
});
```

---

### **Step 6: Configure Environment Variables**

Add to your `.env` file:

```bash
# ============================================================================
# VECTOR EMBEDDINGS (Local)
# ============================================================================

# Model cache directory (models will be downloaded here)
TRANSFORMERS_CACHE=./.cache/transformers

# Preload model on startup (true/false)
# Set to true for production to avoid cold starts
PRELOAD_EMBEDDING_MODEL=true

# Enable background embedding worker (true/false)
ENABLE_EMBEDDING_WORKER=true

# Worker configuration
EMBEDDING_WORKER_INTERVAL=5000        # Poll interval in ms (default: 5000)
EMBEDDING_BATCH_SIZE=10               # Jobs to process per batch (default: 10)
EMBEDDING_MAX_RETRIES=3               # Max retry attempts (default: 3)
EMBEDDING_RETRY_DELAY=60000           # Retry delay in ms (default: 60000)
EMBEDDING_CONCURRENCY=1               # Concurrent workers (default: 1)
```

**For Production**, also set:
```bash
NODE_ENV=production
```

---

### **Step 7: Initial Embedding Generation**

After deployment, you need to generate embeddings for existing data.

#### **Option A: Via API (Gradual)**

The embedding worker will automatically queue new content as it's created or updated (via triggers).

To manually queue existing contexts:
```sql
-- Queue all existing contexts for embedding
INSERT INTO embedding_queue (resource_type, resource_id, priority)
SELECT 'context', id, 5
FROM context_layers
WHERE deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- Queue all existing templates for embedding
INSERT INTO embedding_queue (resource_type, resource_id, priority)
SELECT 'template', id, 5
FROM templates
WHERE deleted_at IS NULL
ON CONFLICT DO NOTHING;
```

The worker will process these automatically.

#### **Option B: Via Script (Fast)**

Create a one-time migration script:

```javascript
// scripts/generate_initial_embeddings.js
import { db } from '../src/utils/database.js';
import { generateBatchEmbeddings, generateContentHash } from '../src/services/localEmbeddingService.js';

async function generateInitialEmbeddings() {
  console.log('Generating embeddings for all contexts...');

  // Fetch all contexts
  const contexts = await db.query(
    `SELECT id, name, description, content FROM context_layers WHERE deleted_at IS NULL`
  );

  const batchSize = 50;
  for (let i = 0; i < contexts.rows.length; i += batchSize) {
    const batch = contexts.rows.slice(i, i + batchSize);
    const texts = batch.map(c => [c.name, c.description, c.content].filter(Boolean).join('\n\n'));

    console.log(`Processing batch ${i / batchSize + 1}...`);
    const { embeddings } = await generateBatchEmbeddings(texts);

    // Insert embeddings
    for (let j = 0; j < batch.length; j++) {
      const context = batch[j];
      const embedding = embeddings[j];
      const contentHash = generateContentHash(texts[j]);

      await db.query(
        `INSERT INTO context_embeddings (context_id, embedding, content_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (context_id) DO UPDATE SET
           embedding = EXCLUDED.embedding,
           content_hash = EXCLUDED.content_hash,
           updated_at = NOW()`,
        [context.id, `[${embedding.join(',')}]`, contentHash]
      );
    }

    console.log(`✓ Processed ${i + batch.length}/${contexts.rows.length}`);
  }

  console.log('✓ All embeddings generated!');
  process.exit(0);
}

generateInitialEmbeddings().catch(console.error);
```

Run it:
```bash
node scripts/generate_initial_embeddings.js
```

---

## Testing

### **Test 1: Verify Service is Running**

Create a test endpoint in `src/routes/handlers/health.js`:

```javascript
import { getServiceStatus } from '../services/localEmbeddingService.js';

export async function healthCheck(req, res) {
  const embeddingStatus = await getServiceStatus();

  return res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      embeddings: embeddingStatus,
    },
  });
}
```

Test it:
```bash
curl http://localhost:3001/api/health
```

Expected response:
```json
{
  "status": "ok",
  "services": {
    "embeddings": {
      "available": true,
      "loaded": true,
      "model": "Xenova/all-MiniLM-L6-v2",
      "dimensions": 384
    }
  }
}
```

### **Test 2: Semantic Search**

```bash
curl -X POST http://localhost:3001/api/contexts/search \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query_text": "help me write better code reviews",
    "limit": 5,
    "min_similarity": 0.6
  }'
```

Expected response:
```json
{
  "success": true,
  "data": {
    "contexts": [
      {
        "context_id": "...",
        "name": "Code Review Guidelines",
        "similarity": 0.87,
        ...
      }
    ]
  }
}
```

### **Test 3: Find Similar Contexts**

```bash
curl -X GET "http://localhost:3001/api/contexts/layers/CONTEXT_ID/similar?limit=5" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### **Test 4: Worker Status**

Check embedding queue status:

```sql
-- View queue status
SELECT status, COUNT(*) as count, AVG(retry_count) as avg_retries
FROM embedding_queue
GROUP BY status;

-- View recent completions
SELECT *
FROM embedding_queue
WHERE status = 'completed'
ORDER BY completed_at DESC
LIMIT 10;
```

---

## Performance Optimization

### **1. Model Caching**

The model (~23MB) is automatically cached after first download:

```bash
# Cache location (default)
./.cache/transformers/

# Production: Use persistent storage
TRANSFORMERS_CACHE=/var/cache/transformers
```

**Docker**: Mount a volume for the cache:
```yaml
volumes:
  - transformers-cache:/app/.cache/transformers
```

### **2. Batch Processing**

For bulk operations, use batch embeddings:

```javascript
import { generateBatchEmbeddings } from './services/localEmbeddingService.js';

// Process 50 texts at once (much faster than 50 individual calls)
const { embeddings } = await generateBatchEmbeddings(texts);
```

### **3. Worker Tuning**

For high-volume systems, adjust worker settings:

```bash
# Process more jobs per batch
EMBEDDING_BATCH_SIZE=50

# Run multiple workers (if you have CPU cores to spare)
EMBEDDING_CONCURRENCY=2

# Poll more frequently
EMBEDDING_WORKER_INTERVAL=2000
```

### **4. Vector Index Tuning**

For large datasets (100k+ vectors), tune HNSW indexes:

```sql
-- For better recall at the cost of memory
DROP INDEX idx_context_embeddings_hnsw;
CREATE INDEX idx_context_embeddings_hnsw
  ON context_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 32, ef_construction = 128);

-- For faster queries at the cost of recall
DROP INDEX idx_context_embeddings_hnsw;
CREATE INDEX idx_context_embeddings_hnsw
  ON context_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 8, ef_construction = 32);
```

---

## Monitoring

### **Queue Health**

Create a monitoring endpoint:

```javascript
import { getWorkerStatus } from './services/embeddingWorker.js';

export async function workerStatus(req, res) {
  const status = await getWorkerStatus();

  return res.json({
    success: true,
    data: status,
  });
}
```

### **Metrics to Track**

```sql
-- Embedding coverage
SELECT
  'contexts' as resource_type,
  COUNT(*) as total,
  COUNT(ce.id) as with_embedding,
  ROUND(100.0 * COUNT(ce.id) / NULLIF(COUNT(*), 0), 2) as coverage_pct
FROM context_layers cl
LEFT JOIN context_embeddings ce ON cl.id = ce.context_id
WHERE cl.deleted_at IS NULL

UNION ALL

SELECT
  'templates' as resource_type,
  COUNT(*) as total,
  COUNT(te.id) as with_embedding,
  ROUND(100.0 * COUNT(te.id) / NULLIF(COUNT(*), 0), 2) as coverage_pct
FROM templates t
LEFT JOIN template_embeddings te ON t.id = te.template_id
WHERE t.deleted_at IS NULL;
```

### **Performance Metrics**

```sql
-- Average embedding generation time
SELECT
  resource_type,
  COUNT(*) as total_processed,
  AVG((metadata->>'generation_time_ms')::int) as avg_time_ms,
  MAX((metadata->>'generation_time_ms')::int) as max_time_ms
FROM (
  SELECT 'context' as resource_type, metadata FROM context_embeddings
  UNION ALL
  SELECT 'template' as resource_type, metadata FROM template_embeddings
) embeddings
WHERE metadata->>'generation_time_ms' IS NOT NULL
GROUP BY resource_type;
```

---

## Troubleshooting

### **Issue: Model download fails**

**Symptom**: `Failed to load embedding model: network error`

**Solution**:
1. Check internet connectivity (first download only)
2. Verify cache directory is writable:
```bash
mkdir -p .cache/transformers
chmod 755 .cache/transformers
```
3. Pre-download the model manually:
```bash
node -e "import('@xenova/transformers').then(t => t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'))"
```

### **Issue: Out of memory**

**Symptom**: `JavaScript heap out of memory`

**Solution**:
1. Increase Node.js memory:
```bash
NODE_OPTIONS="--max-old-space-size=4096" npm start
```
2. Reduce batch size:
```bash
EMBEDDING_BATCH_SIZE=5
```
3. Reduce concurrency:
```bash
EMBEDDING_CONCURRENCY=1
```

### **Issue: Slow embeddings**

**Symptom**: Embeddings take > 500ms each

**Solution**:
1. Preload model on startup (avoid cold starts):
```bash
PRELOAD_EMBEDDING_MODEL=true
```
2. Use batch processing for bulk operations
3. Consider using GPU (if available):
```bash
# Transformers.js will automatically use GPU if available
```

### **Issue: pgvector extension not found**

**Symptom**: `extension "vector" does not exist`

**Solution**:
```sql
-- Check if extension is available
SELECT * FROM pg_available_extensions WHERE name = 'vector';

-- If not available, install it (requires superuser)
CREATE EXTENSION vector;

-- For cloud databases (Neon, Supabase), contact support
```

### **Issue: Queue not processing**

**Symptom**: Jobs stuck in "pending" status

**Solution**:
1. Check worker is running:
```javascript
const status = await getWorkerStatus();
console.log(status.running); // should be true
```
2. Check for errors in logs
3. Manually process a job to test:
```javascript
import { generateEmbeddingNow } from './services/embeddingWorker.js';
await generateEmbeddingNow('context', 'CONTEXT_ID');
```
4. Restart worker:
```javascript
await stopEmbeddingWorker();
await startEmbeddingWorker();
```

---

## Next Steps

After implementing vector embeddings, consider:

1. **MCP Protocol Integration** - Enable Claude Desktop to access your prompt library
2. **Advanced Analytics** - Track which contexts perform best
3. **Auto-Recommendations** - Suggest contexts based on prompt patterns
4. **Prompt Chaining** - Build complex workflows with multiple templates

See the next guides:
- `MCP_INTEGRATION_GUIDE.md` - Model Context Protocol implementation
- `ADVANCED_FEATURES_GUIDE.md` - Power user features

---

## Support

If you encounter issues:

1. Check logs: `tail -f logs/api.log`
2. Verify database migrations: `psql $DATABASE_URL -c "\df find_similar*"`
3. Test embedding service: `node -e "import('./src/services/localEmbeddingService.js').then(s => s.getServiceStatus().then(console.log))"`

---

**Last Updated**: 2025-11-16
**Version**: 1.0
**Maintainer**: PromptCraft Team
