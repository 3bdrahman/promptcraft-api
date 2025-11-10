/**
 * AI Providers Info API Endpoint
 * Returns available providers and their configuration status
 */

import { AI_PROVIDERS, PROVIDER_CONFIGS, MODEL_COSTS } from '../_lib/ai/config.js';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Model information
const MODELS_INFO = {
  [AI_PROVIDERS.OPENAI]: [
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      maxTokens: 128000,
      speed: 'fast',
      ...MODEL_COSTS['gpt-4o']
    },
    {
      id: 'gpt-4-turbo',
      name: 'GPT-4 Turbo',
      maxTokens: 128000,
      speed: 'medium',
      ...MODEL_COSTS['gpt-4-turbo']
    },
    {
      id: 'gpt-3.5-turbo',
      name: 'GPT-3.5 Turbo',
      maxTokens: 16385,
      speed: 'very fast',
      ...MODEL_COSTS['gpt-3.5-turbo']
    }
  ],

  [AI_PROVIDERS.ANTHROPIC]: [
    {
      id: 'claude-3-5-sonnet-20241022',
      name: 'Claude 3.5 Sonnet',
      maxTokens: 200000,
      speed: 'fast',
      ...MODEL_COSTS['claude-3-5-sonnet-20241022']
    },
    {
      id: 'claude-3-opus-20240229',
      name: 'Claude 3 Opus',
      maxTokens: 200000,
      speed: 'medium',
      ...MODEL_COSTS['claude-3-opus-20240229']
    },
    {
      id: 'claude-3-haiku-20240307',
      name: 'Claude 3 Haiku',
      maxTokens: 200000,
      speed: 'very fast',
      ...MODEL_COSTS['claude-3-haiku-20240307']
    }
  ],

  [AI_PROVIDERS.GOOGLE]: [
    {
      id: 'gemini-pro',
      name: 'Gemini Pro',
      maxTokens: 32000,
      speed: 'fast',
      ...MODEL_COSTS['gemini-pro']
    },
    {
      id: 'gemini-1.5-pro',
      name: 'Gemini 1.5 Pro',
      maxTokens: 1000000,
      speed: 'medium',
      ...MODEL_COSTS['gemini-1.5-pro']
    },
    {
      id: 'gemini-1.5-flash',
      name: 'Gemini 1.5 Flash',
      maxTokens: 1000000,
      speed: 'very fast',
      ...MODEL_COSTS['gemini-1.5-flash']
    }
  ],

  [AI_PROVIDERS.HUGGINGFACE]: [
    {
      id: 'mistralai/Mistral-7B-Instruct-v0.2',
      name: 'Mistral 7B Instruct',
      maxTokens: 32768,
      speed: 'fast',
      ...MODEL_COSTS['mistralai/Mistral-7B-Instruct-v0.2']
    },
    {
      id: 'meta-llama/Llama-2-70b-chat-hf',
      name: 'Llama 2 70B Chat',
      maxTokens: 4096,
      speed: 'medium',
      ...MODEL_COSTS['meta-llama/Llama-2-70b-chat-hf']
    },
    {
      id: 'tiiuae/falcon-180B-chat',
      name: 'Falcon 180B Chat',
      maxTokens: 2048,
      speed: 'medium',
      ...MODEL_COSTS['tiiuae/falcon-180B-chat']
    }
  ],

  [AI_PROVIDERS.OLLAMA]: [
    {
      id: 'llama3.2',
      name: 'Llama 3.2',
      maxTokens: 128000,
      speed: 'fast',
      input: 0,
      output: 0
    },
    {
      id: 'mistral',
      name: 'Mistral',
      maxTokens: 32768,
      speed: 'fast',
      input: 0,
      output: 0
    },
    {
      id: 'codellama',
      name: 'Code Llama',
      maxTokens: 16384,
      speed: 'fast',
      input: 0,
      output: 0
    },
    {
      id: 'phi3',
      name: 'Phi-3',
      maxTokens: 128000,
      speed: 'very fast',
      input: 0,
      output: 0
    }
  ]
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

  try {
    const providers = Object.entries(PROVIDER_CONFIGS).map(([id, config]) => {
      const isConfigured = config.requiresApiKey
        ? Boolean(process.env[config.envKey])
        : true;

      return {
        id,
        name: config.name,
        requiresApiKey: config.requiresApiKey,
        isConfigured,
        models: MODELS_INFO[id] || []
      };
    });

    return res.status(200).json({
      success: true,
      providers
    });

  } catch (error) {
    console.error('Providers info error:', error);

    return res.status(500).json({
      success: false,
      error: {
        message: error.message,
        type: error.name
      }
    });
  }
}
