/**
 * Subscriptions API
 * Manages user subscriptions and billing
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

    // GET /subscriptions/current - Get current subscription
    if (method === 'GET' && url.includes('/subscriptions/current')) {
      // Return free tier as default in the format the frontend expects
      return res.json(success({
        tier: 'free',
        status: 'active',
        limits: {
          templates: 10,
          contexts: 5
        },
        billing: {
          nextBillingDate: null,
          amount: 0
        }
      }));
    }

    // GET /subscriptions/plans - Get available plans
    if (method === 'GET' && url.includes('/subscriptions/plans')) {
      return res.json(success({
        free: {
          name: 'Free',
          price: 0,
          description: 'Perfect for getting started',
          features: [
            'Up to 10 templates',
            'Up to 5 context layers',
            'Basic analytics',
            'Community support'
          ]
        },
        pro: {
          name: 'Pro',
          price: 9.99,
          description: 'For power users and teams',
          features: [
            'Unlimited templates',
            'Unlimited context layers',
            'Advanced analytics',
            'Priority support',
            'Team collaboration',
            'API access'
          ]
        },
        enterprise: {
          name: 'Enterprise',
          price: null,
          description: 'For large teams and organizations',
          features: [
            'Everything in Pro',
            'Custom integrations',
            'Dedicated support',
            'SLA guarantees',
            'Custom contracts',
            'On-premise options'
          ]
        }
      }));
    }

    return res.status(404).json(error('Subscription endpoint not found', 404));
  } catch (err) {
    console.error('Subscription error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}
