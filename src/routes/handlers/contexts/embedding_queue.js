/**
 * Embedding Queue Management Handler
 *
 * Manages the background queue for generating embeddings
 * Allows manual triggering and monitoring of embedding generation
 *
 * @module handlers/embeddings/queue
 */

import { db } from '../../utils/database.js';
import { getUserId } from '../../utils/auth.js';
import { success, error } from '../../utils/responses.js';
import { generateEmbedding } from '../../services/localEmbeddingService.js';

/**
 * GET /api/embeddings/queue/status
 * Get the current status of the embedding queue
 */
export async function getEmbeddingQueueStatus(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    // Get queue statistics
    const stats = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
         COUNT(*) FILTER (WHERE status = 'processing') as processing_count,
         COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
         COUNT(*) FILTER (WHERE status = 'failed') as failed_count,
         MAX(created_at) FILTER (WHERE status = 'pending') as oldest_pending,
         MAX(updated_at) FILTER (WHERE status = 'processing') as last_processing,
         AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) FILTER (WHERE status = 'completed') as avg_processing_time
       FROM embedding_queue
       WHERE user_id = $1`,
      [userId]
    );

    // Get user's pending items
    const userPending = await db.query(
      `SELECT
         eq.queue_id,
         eq.context_id,
         eq.priority,
         eq.status,
         eq.created_at,
         eq.retry_count,
         cl.name as context_name
       FROM embedding_queue eq
       LEFT JOIN context_layers cl ON cl.context_id = eq.context_id
       WHERE eq.user_id = $1 AND eq.status IN ('pending', 'processing')
       ORDER BY eq.priority DESC, eq.created_at ASC
       LIMIT 10`,
      [userId]
    );

    const queueStats = stats.rows[0];

    return res.json(success({
      queue_stats: {
        pending: parseInt(queueStats.pending_count),
        processing: parseInt(queueStats.processing_count),
        completed: parseInt(queueStats.completed_count),
        failed: parseInt(queueStats.failed_count),
        oldest_pending: queueStats.oldest_pending,
        last_processing: queueStats.last_processing,
        avg_processing_time_seconds: queueStats.avg_processing_time ? parseFloat(queueStats.avg_processing_time) : null
      },
      your_pending_items: userPending.rows.map(row => ({
        queue_id: row.queue_id,
        context_id: row.context_id,
        context_name: row.context_name,
        priority: row.priority,
        status: row.status,
        created_at: row.created_at,
        retry_count: row.retry_count
      }))
    }));
  } catch (err) {
    console.error('Get queue status error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/embeddings/queue/enqueue
 * Add contexts to the embedding queue
 *
 * Body:
 * - context_ids: Array of context IDs to enqueue
 * - priority: Priority (1-10, default 5)
 */
export async function enqueueEmbeddings(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      context_ids = [],
      priority = 5
    } = req.body;

    if (!Array.isArray(context_ids) || context_ids.length === 0) {
      return res.status(400).json(error('context_ids array is required'));
    }

    // Validate contexts belong to user
    const validContexts = await db.query(
      `SELECT context_id
       FROM context_layers
       WHERE context_id = ANY($1) AND user_id = $2`,
      [context_ids, userId]
    );

    if (validContexts.rows.length === 0) {
      return res.status(404).json(error('No valid contexts found', 404));
    }

    const validIds = validContexts.rows.map(r => r.context_id);

    // Check which contexts already have embeddings or are queued
    const existing = await db.query(
      `SELECT DISTINCT context_id
       FROM (
         SELECT context_id FROM context_embeddings WHERE context_id = ANY($1)
         UNION
         SELECT context_id FROM embedding_queue
         WHERE context_id = ANY($1) AND status IN ('pending', 'processing')
       ) AS existing_embeddings`,
      [validIds]
    );

    const existingIds = new Set(existing.rows.map(r => r.context_id));
    const newIds = validIds.filter(id => !existingIds.has(id));

    if (newIds.length === 0) {
      return res.json(success({
        message: 'All contexts already have embeddings or are queued',
        skipped: validIds.length,
        enqueued: 0
      }));
    }

    // Enqueue new contexts
    const insertValues = newIds.map(id => `('${id}', '${userId}', ${priority})`).join(',');
    await db.query(
      `INSERT INTO embedding_queue (context_id, user_id, priority)
       VALUES ${insertValues}
       ON CONFLICT (context_id) DO NOTHING`
    );

    return res.json(success({
      message: `Enqueued ${newIds.length} contexts for embedding generation`,
      enqueued: newIds.length,
      skipped: validIds.length - newIds.length,
      enqueued_ids: newIds
    }));
  } catch (err) {
    console.error('Enqueue embeddings error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/embeddings/queue/process
 * Manually trigger processing of the embedding queue
 * (Usually runs automatically, but this allows manual triggering)
 *
 * Body:
 * - batch_size: Number of items to process (default 10, max 50)
 */
export async function processEmbeddingQueue(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      batch_size = 10
    } = req.body;

    const actualBatchSize = Math.min(parseInt(batch_size), 50);
    const startTime = Date.now();

    // Get pending items (prioritize user's own contexts)
    const pendingItems = await db.query(
      `SELECT
         eq.queue_id,
         eq.context_id,
         eq.user_id,
         cl.content,
         cl.name
       FROM embedding_queue eq
       INNER JOIN context_layers cl ON cl.context_id = eq.context_id
       WHERE eq.status = 'pending'
       ORDER BY
         CASE WHEN eq.user_id = $1 THEN 0 ELSE 1 END,
         eq.priority DESC,
         eq.created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [userId, actualBatchSize]
    );

    if (pendingItems.rows.length === 0) {
      return res.json(success({
        message: 'No pending items in queue',
        processed: 0,
        total_time_ms: Date.now() - startTime
      }));
    }

    // Mark items as processing
    const queueIds = pendingItems.rows.map(r => r.queue_id);
    await db.query(
      `UPDATE embedding_queue
       SET status = 'processing', updated_at = NOW()
       WHERE queue_id = ANY($1)`,
      [queueIds]
    );

    // Process each item
    const results = {
      processed: 0,
      failed: 0,
      errors: []
    };

    for (const item of pendingItems.rows) {
      try {
        // Generate embedding
        const { embedding } = await generateEmbedding(item.content);

        // Store embedding
        await db.query(
          `INSERT INTO context_embeddings (context_id, embedding, embedding_model, created_at)
           VALUES ($1, $2, 'all-MiniLM-L6-v2', NOW())
           ON CONFLICT (context_id)
           DO UPDATE SET
             embedding = EXCLUDED.embedding,
             embedding_model = EXCLUDED.embedding_model,
             updated_at = NOW()`,
          [item.context_id, `[${embedding.join(',')}]`]
        );

        // Mark as completed
        await db.query(
          `UPDATE embedding_queue
           SET status = 'completed', updated_at = NOW()
           WHERE queue_id = $1`,
          [item.queue_id]
        );

        results.processed++;
      } catch (err) {
        console.error(`Failed to process embedding for context ${item.context_id}:`, err);

        // Mark as failed and increment retry count
        await db.query(
          `UPDATE embedding_queue
           SET status = 'failed',
               error_message = $1,
               retry_count = retry_count + 1,
               updated_at = NOW()
           WHERE queue_id = $2`,
          [err.message, item.queue_id]
        );

        results.failed++;
        results.errors.push({
          context_id: item.context_id,
          context_name: item.name,
          error: err.message
        });
      }
    }

    return res.json(success({
      message: `Processed ${results.processed} embeddings`,
      processed: results.processed,
      failed: results.failed,
      errors: results.errors,
      total_time_ms: Date.now() - startTime
    }));
  } catch (err) {
    console.error('Process queue error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * DELETE /api/embeddings/queue/:id
 * Remove an item from the queue
 */
export async function removeFromQueue(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { id } = req.params;

    const result = await db.query(
      `DELETE FROM embedding_queue
       WHERE queue_id = $1 AND user_id = $2
       RETURNING queue_id`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Queue item not found', 404));
    }

    return res.json(success({
      message: 'Removed from queue',
      queue_id: id
    }));
  } catch (err) {
    console.error('Remove from queue error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

export default {
  getEmbeddingQueueStatus,
  enqueueEmbeddings,
  processEmbeddingQueue,
  removeFromQueue
};
