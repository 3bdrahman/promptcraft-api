/**
 * AI Provider Configuration
 * Centralized configuration for all AI providers
 */

export const AI_PROVIDERS = {
  HUGGINGFACE: 'huggingface',
  OLLAMA: 'ollama',
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GOOGLE: 'google'
};

export const MODEL_COSTS = {
  // OpenAI pricing (per 1K tokens)
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },

  // Anthropic pricing
  'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
  'claude-3-opus-20240229': { input: 0.015, output: 0.075 },
  'claude-3-haiku-20240307': { input: 0.00025, output: 0.00125 },

  // Google pricing
  'gemini-pro': { input: 0.00125, output: 0.00375 },
  'gemini-1.5-pro': { input: 0.0035, output: 0.0105 },
  'gemini-1.5-flash': { input: 0.00035, output: 0.00105 },

  // HuggingFace (estimated)
  'mistralai/Mistral-7B-Instruct-v0.2': { input: 0.0002, output: 0.0002 },
  'meta-llama/Llama-2-70b-chat-hf': { input: 0.0007, output: 0.0009 },
  'tiiuae/falcon-180B-chat': { input: 0.001, output: 0.001 }
};

export const PROVIDER_CONFIGS = {
  [AI_PROVIDERS.OPENAI]: {
    name: 'OpenAI',
    requiresApiKey: true,
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1'
  },

  [AI_PROVIDERS.ANTHROPIC]: {
    name: 'Anthropic',
    requiresApiKey: true,
    envKey: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1'
  },

  [AI_PROVIDERS.GOOGLE]: {
    name: 'Google AI',
    requiresApiKey: true,
    envKey: 'GOOGLE_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
  },

  [AI_PROVIDERS.HUGGINGFACE]: {
    name: 'HuggingFace',
    requiresApiKey: true,
    envKey: 'HUGGINGFACE_API_KEY',
    baseUrl: 'https://api-inference.huggingface.co'
  },

  [AI_PROVIDERS.OLLAMA]: {
    name: 'Ollama',
    requiresApiKey: false,
    baseUrl: 'http://localhost:11434'
  }
};

export function calculateCost(modelId, inputTokens, outputTokens) {
  const costs = MODEL_COSTS[modelId];
  if (!costs) {
    return 0;
  }

  const inputCost = (inputTokens / 1000) * costs.input;
  const outputCost = (outputTokens / 1000) * costs.output;

  return inputCost + outputCost;
}

export function estimateTokens(text) {
  // Rough estimation: ~4 characters per token
  return Math.ceil(text.length / 4);
}
