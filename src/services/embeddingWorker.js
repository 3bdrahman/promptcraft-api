/**
 * Embedding Worker
 *
 * Background job processor for generating embeddings asynchronously.
 * Processes the embedding_queue table and generates embeddings for contexts and templates.
 *
 * Usage:
 *   node src/services/embeddingWorker.js
 *
 * Or integrate into your main server:
 *   import { startEmbeddingWorker, stopEmbeddingWorker } from './services/embeddingWorker.js';
 *   await startEmbeddingWorker();
 *
 * @module services/embeddingWorker
 */

import { db } from '../utils/database.js';
import {
  generateEmbedding,
  generateBatchEmbeddings,
  generateContentHash,
  preloadModel,
} from './localEmbeddingService.js';

// Worker configuration
const WORKER_CONFIG = {
  pollInterval: parseInt(process.env.EMBEDDING_WORKER_INTERVAL) || 5000, // 5 seconds
  batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE) || 10,
  maxRetries: parseInt(process.env.EMBEDDING_MAX_RETRIES) || 3,
  retryDelay: parseInt(process.env.EMBEDDING_RETRY_DELAY) || 60000, // 1 minute
  concurrency: parseInt(process.env.EMBEDDING_CONCURRENCY) || 1,
};

let isRunning = false;
let workerInterval = null;
let activeProcessing = 0;

/**
 * Process a single embedding job
 *
 * @param {Object} job - Job from embedding_queue
 * @returns {Promise<boolean>} Success status
 */
async function processJob(job) {
  const { id, resource_type, resource_id, retry_count } = job;

  try {
    console.log(`[EmbeddingWorker] Processing ${resource_type} ${resource_id}...`);

    // Mark job as processing
    await db.query(
      `UPDATE embedding_queue
       SET status = 'processing', started_at = NOW()
       WHERE id = $1`,
      [id]
    );

    let content = '';
    let tableName = '';
    let embeddingTable = '';

    // Fetch the resource content
    if (resource_type === 'context') {
      tableName = 'context_layers';
      embeddingTable = 'context_embeddings';

      const result = await db.query(
        `SELECT name, description, content FROM context_layers WHERE id = $1`,
        [resource_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`Context ${resource_id} not found`);
      }

      const row = result.rows[0];
      // Combine name, description, and content for embedding
      content = [row.name, row.description, row.content]
        .filter(Boolean)
        .join('\n\n');
    } else if (resource_type === 'template') {
      tableName = 'templates';
      embeddingTable = 'template_embeddings';

      const result = await db.query(
        `SELECT name, description, content FROM templates WHERE id = $1`,
        [resource_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`Template ${resource_id} not found`);
      }

      const row = result.rows[0];
      content = [row.name, row.description, row.content]
        .filter(Boolean)
        .join('\n\n');
    } else {
      throw new Error(`Unknown resource type: ${resource_type}`);
    }

    if (!content || content.trim().length === 0) {
      throw new Error(`Empty content for ${resource_type} ${resource_id}`);
    }

    // Generate embedding
    const startTime = Date.now();
    const { embedding, model } = await generateEmbedding(content);
    const generationTime = Date.now() - startTime;

    // Calculate content hash
    const contentHash = generateContentHash(content);

    // Store embedding
    const columnName = resource_type === 'context' ? 'context_id' : 'template_id';

    await db.query(
      `INSERT INTO ${embeddingTable} (${columnName}, embedding, content_hash, model_id, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (${columnName})
       DO UPDATE SET
         embedding = EXCLUDED.embedding,
         content_hash = EXCLUDED.content_hash,
         model_id = EXCLUDED.model_id,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        resource_id,
        `[${embedding.join(',')}]`, // Convert array to pgvector format
        contentHash,
        model,
        JSON.stringify({ generation_time_ms: generationTime }),
      ]
    );

    // Mark job as completed
    await db.query(
      `UPDATE embedding_queue
       SET status = 'completed', completed_at = NOW()
       WHERE id = $1`,
      [id]
    );

    console.log(
      `[EmbeddingWorker] ✓ Completed ${resource_type} ${resource_id} in ${generationTime}ms`
    );

    return true;
  } catch (error) {
    console.error(`[EmbeddingWorker] ✗ Failed to process ${resource_type} ${resource_id}:`, error);

    // Check if we should retry
    if (retry_count < WORKER_CONFIG.maxRetries) {
      // Mark as pending for retry (with delay)
      await db.query(
        `UPDATE embedding_queue
         SET status = 'pending', retry_count = retry_count + 1, error_message = $2
         WHERE id = $1`,
        [id, error.message]
      );
      console.log(
        `[EmbeddingWorker] Will retry ${resource_type} ${resource_id} (attempt ${retry_count + 2}/${WORKER_CONFIG.maxRetries + 1})`
      );
    } else {
      // Max retries exceeded, mark as failed
      await db.query(
        `UPDATE embedding_queue
         SET status = 'failed', error_message = $2, completed_at = NOW()
         WHERE id = $1`,
        [id, error.message]
      );
      console.error(
        `[EmbeddingWorker] ✗ Permanently failed ${resource_type} ${resource_id} after ${retry_count + 1} attempts`
      );
    }

    return false;
  }
}

/**
 * Process batch of embedding jobs
 *
 * @returns {Promise<number>} Number of jobs processed
 */
async function processBatch() {
  if (activeProcessing >= WORKER_CONFIG.concurrency) {
    return 0;
  }

  activeProcessing++;

  try {
    // Fetch pending jobs by priority
    const result = await db.query(
      `SELECT id, resource_type, resource_id, priority, retry_count
       FROM embedding_queue
       WHERE status = 'pending'
       ORDER BY priority ASC, created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [WORKER_CONFIG.batchSize]
    );

    const jobs = result.rows;

    if (jobs.length === 0) {
      return 0;
    }

    console.log(`[EmbeddingWorker] Processing batch of ${jobs.length} jobs...`);

    // Process jobs concurrently
    const results = await Promise.allSettled(
      jobs.map(job => processJob(job))
    );

    const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    const failCount = results.length - successCount;

    console.log(
      `[EmbeddingWorker] Batch complete: ${successCount} succeeded, ${failCount} failed`
    );

    return results.length;
  } catch (error) {
    console.error('[EmbeddingWorker] Error processing batch:', error);
    return 0;
  } finally {
    activeProcessing--;
  }
}

/**
 * Main worker loop
 */
async function workerLoop() {
  if (!isRunning) {
    return;
  }

  try {
    const processedCount = await processBatch();

    if (processedCount > 0) {
      // If we processed jobs, check for more immediately
      setImmediate(workerLoop);
    } else {
      // No jobs found, wait before polling again
      workerInterval = setTimeout(workerLoop, WORKER_CONFIG.pollInterval);
    }
  } catch (error) {
    console.error('[EmbeddingWorker] Worker loop error:', error);
    // Wait before retrying
    workerInterval = setTimeout(workerLoop, WORKER_CONFIG.pollInterval);
  }
}

/**
 * Start the embedding worker
 *
 * @returns {Promise<void>}
 */
export async function startEmbeddingWorker() {
  if (isRunning) {
    console.log('[EmbeddingWorker] Worker already running');
    return;
  }

  console.log('[EmbeddingWorker] Starting worker...');
  console.log('[EmbeddingWorker] Config:', WORKER_CONFIG);

  try {
    // Preload the embedding model to avoid cold starts
    await preloadModel();

    isRunning = true;
    workerLoop();

    console.log('[EmbeddingWorker] Worker started successfully');
  } catch (error) {
    console.error('[EmbeddingWorker] Failed to start worker:', error);
    throw error;
  }
}

/**
 * Stop the embedding worker
 *
 * @returns {Promise<void>}
 */
export async function stopEmbeddingWorker() {
  if (!isRunning) {
    console.log('[EmbeddingWorker] Worker not running');
    return;
  }

  console.log('[EmbeddingWorker] Stopping worker...');

  isRunning = false;

  if (workerInterval) {
    clearTimeout(workerInterval);
    workerInterval = null;
  }

  // Wait for active jobs to complete (with timeout)
  const timeout = 30000; // 30 seconds
  const startTime = Date.now();

  while (activeProcessing > 0 && Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (activeProcessing > 0) {
    console.warn(
      `[EmbeddingWorker] Stopped with ${activeProcessing} active jobs (timeout exceeded)`
    );
  } else {
    console.log('[EmbeddingWorker] Worker stopped successfully');
  }
}

/**
 * Get worker status
 *
 * @returns {Promise<Object>} Worker status
 */
export async function getWorkerStatus() {
  const queueStats = await db.query(
    `SELECT
       status,
       COUNT(*) as count,
       AVG(retry_count) as avg_retries
     FROM embedding_queue
     GROUP BY status`
  );

  return {
    running: isRunning,
    activeJobs: activeProcessing,
    config: WORKER_CONFIG,
    queueStats: queueStats.rows,
  };
}

/**
 * Manually trigger embedding generation for a resource
 * Bypasses the queue and processes immediately
 *
 * @param {string} resourceType - 'context' or 'template'
 * @param {string} resourceId - UUID of the resource
 * @returns {Promise<Object>} Embedding result
 */
export async function generateEmbeddingNow(resourceType, resourceId) {
  console.log(`[EmbeddingWorker] Generating embedding for ${resourceType} ${resourceId} (immediate)`);

  const job = {
    id: null, // Not from queue
    resource_type: resourceType,
    resource_id: resourceId,
    retry_count: 0,
  };

  const success = await processJob(job);

  if (!success) {
    throw new Error(`Failed to generate embedding for ${resourceType} ${resourceId}`);
  }

  // Fetch the generated embedding
  const tableName = resourceType === 'context' ? 'context_embeddings' : 'template_embeddings';
  const columnName = resourceType === 'context' ? 'context_id' : 'template_id';

  const result = await db.query(
    `SELECT * FROM ${tableName} WHERE ${columnName} = $1`,
    [resourceId]
  );

  return result.rows[0];
}

/**
 * Clean up old completed/failed jobs
 *
 * @param {number} retentionDays - Number of days to retain completed jobs
 * @returns {Promise<number>} Number of jobs deleted
 */
export async function cleanupOldJobs(retentionDays = 7) {
  const result = await db.query(
    `DELETE FROM embedding_queue
     WHERE status IN ('completed', 'failed')
     AND completed_at < NOW() - INTERVAL '${retentionDays} days'
     RETURNING id`
  );

  const deletedCount = result.rowCount;
  console.log(`[EmbeddingWorker] Cleaned up ${deletedCount} old jobs`);
  return deletedCount;
}

// If running as standalone script
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Starting Embedding Worker as standalone process...');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await stopEmbeddingWorker();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    await stopEmbeddingWorker();
    process.exit(0);
  });

  // Start worker
  startEmbeddingWorker().catch(error => {
    console.error('Failed to start worker:', error);
    process.exit(1);
  });
}

// Default export
export default {
  startEmbeddingWorker,
  stopEmbeddingWorker,
  getWorkerStatus,
  generateEmbeddingNow,
  cleanupOldJobs,
};
