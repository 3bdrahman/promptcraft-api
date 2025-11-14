/**
 * Embedding Service - Generate and manage text embeddings
 * Supports OpenAI and HuggingFace providers
 */

import OpenAI from 'openai';
import { HfInference } from '@huggingface/inference';

// Initialize OpenAI client
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Initialize HuggingFace client
const hf = process.env.HUGGINGFACE_API_KEY
  ? new HfInference(process.env.HUGGINGFACE_API_KEY)
  : null;

// Configuration
const DEFAULT_MODEL = 'openai'; // 'openai' or 'huggingface'
const OPENAI_MODEL = 'text-embedding-3-small'; // Cost-effective, 1536 dimensions
const HF_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'; // 384 dimensions

/**
 * Generate embedding vector for given text
 * @param {string} text - Text to embed
 * @param {string} provider - 'openai' or 'huggingface' (optional)
 * @returns {Promise<number[]|null>} Embedding vector or null if failed
 */
export async function generateEmbedding(text, provider = DEFAULT_MODEL) {
  if (!text || typeof text !== 'string') {
    console.warn('Invalid text provided to generateEmbedding');
    return null;
  }

  // Normalize text (trim, limit length)
  const normalizedText = text.trim().slice(0, 8000); // OpenAI limit is 8191 tokens

  if (!normalizedText) {
    console.warn('Empty text after normalization');
    return null;
  }

  try {
    // Try OpenAI first (preferred for quality)
    if (provider === 'openai' && openai) {
      const response = await openai.embeddings.create({
        model: OPENAI_MODEL,
        input: normalizedText,
        encoding_format: 'float',
      });

      return response.data[0].embedding;
    }

    // Fallback to HuggingFace
    if (provider === 'huggingface' && hf) {
      const result = await hf.featureExtraction({
        model: HF_MODEL,
        inputs: normalizedText,
      });

      // HuggingFace returns nested array, flatten it
      return Array.isArray(result[0]) ? result[0] : result;
    }

    // Try fallback if primary provider fails
    if (provider === 'openai' && hf) {
      console.warn('OpenAI not available, falling back to HuggingFace');
      return generateEmbedding(text, 'huggingface');
    }

    if (provider === 'huggingface' && openai) {
      console.warn('HuggingFace not available, falling back to OpenAI');
      return generateEmbedding(text, 'openai');
    }

    console.error('No embedding provider available. Please configure OPENAI_API_KEY or HUGGINGFACE_API_KEY');
    return null;

  } catch (error) {
    console.error(`Error generating embedding with ${provider}:`, error.message);

    // Try fallback provider
    if (provider === 'openai' && hf) {
      console.log('Attempting fallback to HuggingFace...');
      return generateEmbedding(text, 'huggingface');
    }
    if (provider === 'huggingface' && openai) {
      console.log('Attempting fallback to OpenAI...');
      return generateEmbedding(text, 'openai');
    }

    return null;
  }
}

/**
 * Calculate cosine similarity between two embedding vectors
 * @param {number[]} embedding1 - First embedding vector
 * @param {number[]} embedding2 - Second embedding vector
 * @returns {number} Similarity score between 0 and 1
 */
export function calculateSimilarity(embedding1, embedding2) {
  if (!embedding1 || !embedding2) {
    return 0;
  }

  if (!Array.isArray(embedding1) || !Array.isArray(embedding2)) {
    console.warn('Invalid embeddings provided to calculateSimilarity');
    return 0;
  }

  if (embedding1.length !== embedding2.length) {
    console.warn('Embedding dimensions do not match');
    return 0;
  }

  // Cosine similarity formula
  let dotProduct = 0;
  let magnitude1 = 0;
  let magnitude2 = 0;

  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i];
    magnitude1 += embedding1[i] * embedding1[i];
    magnitude2 += embedding2[i] * embedding2[i];
  }

  magnitude1 = Math.sqrt(magnitude1);
  magnitude2 = Math.sqrt(magnitude2);

  if (magnitude1 === 0 || magnitude2 === 0) {
    return 0;
  }

  // Returns value between -1 and 1, normalize to 0-1
  const similarity = dotProduct / (magnitude1 * magnitude2);
  return (similarity + 1) / 2;
}

/**
 * Batch generate embeddings for multiple texts
 * @param {string[]} texts - Array of texts to embed
 * @param {string} provider - Provider to use
 * @returns {Promise<(number[]|null)[]>} Array of embeddings
 */
export async function generateBatchEmbeddings(texts, provider = DEFAULT_MODEL) {
  if (!Array.isArray(texts)) {
    console.warn('Invalid texts array provided');
    return [];
  }

  // Process in batches to avoid rate limits
  const BATCH_SIZE = 20;
  const results = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(text => generateEmbedding(text, provider));
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Small delay to respect rate limits
    if (i + BATCH_SIZE < texts.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}

/**
 * Check if embedding service is configured
 * @returns {boolean} True if at least one provider is available
 */
export function isEmbeddingServiceAvailable() {
  return !!(openai || hf);
}

/**
 * Get current provider status
 * @returns {Object} Status of each provider
 */
export function getProviderStatus() {
  return {
    openai: !!openai,
    huggingface: !!hf,
    default: DEFAULT_MODEL,
  };
}

export default {
  generateEmbedding,
  calculateSimilarity,
  generateBatchEmbeddings,
  isEmbeddingServiceAvailable,
  getProviderStatus,
};
