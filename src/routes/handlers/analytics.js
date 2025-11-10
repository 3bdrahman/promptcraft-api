/**
 * Analytics API
 * Provides usage analytics and dashboard stats
 */

import { db } from '../../utils/database.js';
import { getUserId } from '../../middleware/auth/index.js';
import { success, error, handleCors } from '../../utils/responses.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const { method, url } = req;

  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    // GET /analytics/dashboard - Dashboard overview stats
    if (method === 'GET' && url.includes('/analytics/dashboard')) {
      // Return placeholder data in the format the frontend expects
      return res.json(success({
        stats: {
          templates: 0,
          contexts: 0,
          tokensThisMonth: 0
        },
        recentTemplates: [],
        recentContexts: []
      }));
    }

    // GET /analytics/usage - Detailed usage stats
    if (method === 'GET' && url.includes('/analytics/usage')) {
      // Return placeholder data - implement actual analytics later
      return res.json(success({
        daily: [],
        weekly: [],
        monthly: [],
        total: 0
      }));
    }

    return res.status(404).json(error('Analytics endpoint not found', 404));
  } catch (err) {
    console.error('Analytics error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
