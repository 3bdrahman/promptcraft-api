/**
 * AI Embeddings API Endpoint
 * Generate embeddings for semantic search
 */

import { AI_PROVIDERS, PROVIDER_CONFIGS } from '../_lib/ai/config.js';
import { generateOpenAIEmbedding } from '../_lib/ai/providers/openai.js';
import { generateHuggingFaceEmbedding } from '../_lib/ai/providers/huggingface.js';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req, res) {
  // Set CORS headers first (before any response)
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    const {
      text,
      provider = 'openai',
      modelId
    } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: text'
      });
    }

    // Get provider config
    const providerConfig = PROVIDER_CONFIGS[provider];
    if (!providerConfig) {
      return res.status(400).json({
        success: false,
        error: `Provider not found: ${provider}`
      });
    }

    // Check API key
    if (providerConfig.requiresApiKey) {
      const apiKey = process.env[providerConfig.envKey];
      if (!apiKey) {
        return res.status(500).json({
          success: false,
          error: `API key not configured for provider: ${provider}`
        });
      }
    }

    let result;

    switch (provider) {
      case AI_PROVIDERS.OPENAI:
        result = await generateOpenAIEmbedding(
          text,
          modelId || 'text-embedding-3-small',
          process.env.OPENAI_API_KEY
        );
        break;

      case AI_PROVIDERS.HUGGINGFACE:
        result = await generateHuggingFaceEmbedding(
          text,
          modelId || 'sentence-transformers/all-MiniLM-L6-v2',
          process.env.HUGGINGFACE_API_KEY
        );
        break;

      default:
        return res.status(400).json({
          success: false,
          error: `Embeddings not supported for provider: ${provider}`
        });
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error('Embedding generation error:', error);

    return res.status(500).json({
      success: false,
      error: {
        message: error.message,
        type: error.name
      }
    });
  }
}
