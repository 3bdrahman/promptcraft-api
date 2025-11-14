/**
 * AI Generation API Endpoint
 * Centralized endpoint for all AI providers
 * Used by both web app and extension
 */

import { AI_PROVIDERS, PROVIDER_CONFIGS } from '../../../services/ai/config.js';
import { generateOpenAI } from '../../../services/ai/providers/openai.js';
import { generateAnthropic } from '../../../services/ai/providers/anthropic.js';
import { generateGoogle } from '../../../services/ai/providers/google.js';
import { generateHuggingFace } from '../../../services/ai/providers/huggingface.js';

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

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    const {
      provider,
      modelId,
      prompt,
      systemPrompt = '',
      maxTokens = 2048,
      temperature = 0.7,
      messages,
      apiKey: clientApiKey // Optional client-provided API key
    } = req.body;

    // Validate required fields
    if (!provider || !modelId || !prompt) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: provider, modelId, prompt'
      });
    }

    // Validate provider
    if (!Object.values(AI_PROVIDERS).includes(provider)) {
      return res.status(400).json({
        success: false,
        error: `Invalid provider: ${provider}`
      });
    }

    // Get provider config
    const providerConfig = PROVIDER_CONFIGS[provider];
    if (!providerConfig) {
      return res.status(400).json({
        success: false,
        error: `Provider configuration not found: ${provider}`
      });
    }

    // Determine which API key to use (client-provided or environment variable)
    let apiKeyToUse = clientApiKey || process.env[providerConfig.envKey];

    // Check if provider requires API key
    if (providerConfig.requiresApiKey && !apiKeyToUse) {
      return res.status(400).json({
        success: false,
        error: `API key required for provider: ${provider}. Either provide 'apiKey' in request body or set ${providerConfig.envKey} in environment variables.`
      });
    }

    // Prepare parameters
    const params = {
      modelId,
      prompt,
      systemPrompt,
      maxTokens,
      temperature,
      messages
    };

    // Route to appropriate provider
    let result;

    switch (provider) {
      case AI_PROVIDERS.OPENAI:
        result = await generateOpenAI(params, apiKeyToUse);
        break;

      case AI_PROVIDERS.ANTHROPIC:
        result = await generateAnthropic(params, apiKeyToUse);
        break;

      case AI_PROVIDERS.GOOGLE:
        result = await generateGoogle(params, apiKeyToUse);
        break;

      case AI_PROVIDERS.HUGGINGFACE:
        result = await generateHuggingFace(params, apiKeyToUse);
        break;

      case AI_PROVIDERS.OLLAMA:
        return res.status(400).json({
          success: false,
          error: 'Ollama should be called directly from the client (runs locally)'
        });

      default:
        return res.status(400).json({
          success: false,
          error: `Provider not implemented: ${provider}`
        });
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error('AI generation error:', error);

    return res.status(500).json({
      success: false,
      error: {
        message: error.message,
        type: error.name
      }
    });
  }
}
