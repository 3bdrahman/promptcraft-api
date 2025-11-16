/**
 * Embedding Queue Management API
 * Monitor and manage embedding generation queue
 */

import { db } from '../../../utils/database.js';
import { getUserId } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';

/**
 * GET /api/embeddings/queue
 * Get embedding queue status
 */
export async function getQueueStatus(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      resource_type = null,
      status = null,
      limit = 50
    } = req.query;

    let query = `
      SELECT
        eq.*,
        CASE
          WHEN eq.resource_type = 'context' THEN cl.name
          WHEN eq.resource_type = 'template' THEN t.name
        END as resource_name
      FROM embedding_queue eq
      LEFT JOIN context_layers cl ON eq.resource_type = 'context' AND eq.resource_id = cl.id
      LEFT JOIN templates t ON eq.resource_type = 'template' AND eq.resource_id = t.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

    if (resource_type) {
      paramCount++;
      query += ` AND eq.resource_type = $${paramCount}`;
      params.push(resource_type);
    }

    if (status) {
      paramCount++;
      query += ` AND eq.status = $${paramCount}`;
      params.push(status);
    }

    query += ` ORDER BY eq.priority ASC, eq.created_at ASC LIMIT $${paramCount + 1}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);

    // Get queue statistics
    const statsResult = await db.query(`
      SELECT
        status,
        resource_type,
        COUNT(*) as count
      FROM embedding_queue
      GROUP BY status, resource_type
      ORDER BY status, resource_type
    `);

    return res.json(success({
      queue: result.rows,
      statistics: statsResult.rows
    }));
  } catch (err) {
    console.error('Get queue status error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/embeddings/queue/process
 * Process next pending items from queue
 */
export async function processQueue(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { batch_size = 10 } = req.body;

    // Get pending items
    const pendingResult = await db.query(
      `SELECT * FROM embedding_queue
       WHERE status = 'pending'
       ORDER BY priority ASC, created_at ASC
       LIMIT $1`,
      [batch_size]
    );

    if (pendingResult.rows.length === 0) {
      return res.json(success({
        message: 'No pending items in queue',
        processed: 0
      }));
    }

    // Mark as processing
    const ids = pendingResult.rows.map(row => row.id);
    await db.query(
      `UPDATE embedding_queue
       SET status = 'processing', started_at = NOW()
       WHERE id = ANY($1)`,
      [ids]
    );

    return res.json(success({
      message: 'Items marked for processing',
      processed: pendingResult.rows.length,
      items: pendingResult.rows
    }));
  } catch (err) {
    console.error('Process queue error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * DELETE /api/embeddings/queue/:id
 * Remove item from queue
 */
export async function removeFromQueue(req, res, queueId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const result = await db.query(
      'DELETE FROM embedding_queue WHERE id = $1 RETURNING *',
      [queueId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Queue item not found', 404));
    }

    return res.json(success({
      message: 'Item removed from queue',
      item: result.rows[0]
    }));
  } catch (err) {
    console.error('Remove from queue error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/embeddings/queue/:id/retry
 * Retry failed embedding generation
 */
export async function retryQueueItem(req, res, queueId) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const result = await db.query(
      `UPDATE embedding_queue
       SET status = 'pending',
           error_message = NULL,
           started_at = NULL,
           completed_at = NULL
       WHERE id = $1
       RETURNING *`,
      [queueId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Queue item not found', 404));
    }

    return res.json(success({
      message: 'Item queued for retry',
      item: result.rows[0]
    }));
  } catch (err) {
    console.error('Retry queue item error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/embeddings/queue/clear
 * Clear completed or failed items from queue
 */
export async function clearQueue(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { status = 'completed' } = req.body;

    if (!['completed', 'failed'].includes(status)) {
      return res.status(400).json(error('status must be "completed" or "failed"'));
    }

    const result = await db.query(
      'DELETE FROM embedding_queue WHERE status = $1 RETURNING id',
      [status]
    );

    return res.json(success({
      message: `Cleared ${status} items from queue`,
      count: result.rows.length
    }));
  } catch (err) {
    console.error('Clear queue error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
