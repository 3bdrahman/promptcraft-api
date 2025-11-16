/**
 * Local Embedding Service
 *
 * Generates text embeddings using Transformers.js - runs entirely locally!
 * No external API calls, no cost, complete privacy.
 *
 * Model: Xenova/all-MiniLM-L6-v2
 * - Dimensions: 384
 * - Speed: ~50-100ms per embedding on CPU
 * - Quality: Excellent for semantic search
 * - Size: ~23MB download (cached after first use)
 *
 * @module services/localEmbeddingService
 */

import { pipeline, env } from '@xenova/transformers';
import crypto from 'crypto';

// Configure Transformers.js environment
// Cache models in a persistent directory (important for production!)
env.cacheDir = process.env.TRANSFORMERS_CACHE || './.cache/transformers';

// Disable remote models in production for security
if (process.env.NODE_ENV === 'production') {
  env.allowRemoteModels = true; // Set to false if you want to pre-download models
}

// Singleton pattern for the embedding pipeline
// Loading the model is expensive (~2-3 seconds), so we cache it
let embeddingPipeline = null;
let isLoading = false;
let loadPromise = null;

/**
 * Default model configuration
 */
const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIMENSIONS = 384;

/**
 * Initialize or get the embedding pipeline
 * Uses singleton pattern to avoid loading the model multiple times
 *
 * @returns {Promise<pipeline>} The embedding pipeline
 */
async function getEmbeddingPipeline() {
  // If already loaded, return immediately
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  // If currently loading, wait for it
  if (isLoading && loadPromise) {
    return loadPromise;
  }

  // Start loading
  isLoading = true;
  loadPromise = (async () => {
    try {
      console.log(`[LocalEmbedding] Loading model: ${DEFAULT_MODEL}...`);
      const startTime = Date.now();

      embeddingPipeline = await pipeline(
        'feature-extraction',
        DEFAULT_MODEL,
        {
          quantized: true, // Use quantized model for faster inference
        }
      );

      const loadTime = Date.now() - startTime;
      console.log(`[LocalEmbedding] Model loaded successfully in ${loadTime}ms`);

      return embeddingPipeline;
    } catch (error) {
      console.error('[LocalEmbedding] Failed to load model:', error);
      isLoading = false;
      loadPromise = null;
      throw new Error(`Failed to load embedding model: ${error.message}`);
    } finally {
      isLoading = false;
    }
  })();

  return loadPromise;
}

/**
 * Generate embedding for a single text
 *
 * @param {string} text - Text to embed
 * @param {Object} options - Options
 * @param {boolean} options.normalize - Normalize embeddings (default: true)
 * @param {boolean} options.pooling - Pooling strategy: 'mean' or 'cls' (default: 'mean')
 * @returns {Promise<{embedding: number[], dimensions: number, model: string}>}
 */
export async function generateEmbedding(text, options = {}) {
  const { normalize = true, pooling = 'mean' } = options;

  if (!text || typeof text !== 'string') {
    throw new Error('Text must be a non-empty string');
  }

  if (text.trim().length === 0) {
    throw new Error('Text cannot be empty or whitespace');
  }

  try {
    const pipeline = await getEmbeddingPipeline();

    // Generate embedding
    const output = await pipeline(text, {
      pooling,
      normalize,
    });

    // Extract the embedding array
    // output.data is a Float32Array
    const embedding = Array.from(output.data);

    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Unexpected embedding dimensions: got ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}`
      );
    }

    return {
      embedding,
      dimensions: EMBEDDING_DIMENSIONS,
      model: DEFAULT_MODEL,
    };
  } catch (error) {
    console.error('[LocalEmbedding] Error generating embedding:', error);
    throw new Error(`Failed to generate embedding: ${error.message}`);
  }
}

/**
 * Generate embeddings for multiple texts in batch
 * More efficient than calling generateEmbedding() multiple times
 *
 * @param {string[]} texts - Array of texts to embed
 * @param {Object} options - Options (same as generateEmbedding)
 * @returns {Promise<{embeddings: number[][], dimensions: number, model: string}>}
 */
export async function generateBatchEmbeddings(texts, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('texts must be a non-empty array');
  }

  const { normalize = true, pooling = 'mean' } = options;

  try {
    const pipeline = await getEmbeddingPipeline();

    // Process all texts at once for better performance
    const output = await pipeline(texts, {
      pooling,
      normalize,
    });

    // Extract embeddings
    // For batch processing, output.data is a flat array
    const flatEmbeddings = Array.from(output.data);

    // Reshape into array of embeddings
    const embeddings = [];
    for (let i = 0; i < texts.length; i++) {
      const start = i * EMBEDDING_DIMENSIONS;
      const end = start + EMBEDDING_DIMENSIONS;
      embeddings.push(flatEmbeddings.slice(start, end));
    }

    return {
      embeddings,
      dimensions: EMBEDDING_DIMENSIONS,
      model: DEFAULT_MODEL,
    };
  } catch (error) {
    console.error('[LocalEmbedding] Error generating batch embeddings:', error);
    throw new Error(`Failed to generate batch embeddings: ${error.message}`);
  }
}

/**
 * Calculate cosine similarity between two embeddings
 * Returns a value between -1 and 1, where:
 * - 1 = identical
 * - 0 = orthogonal (no similarity)
 * - -1 = opposite
 *
 * @param {number[]} embedding1 - First embedding
 * @param {number[]} embedding2 - Second embedding
 * @returns {number} Cosine similarity
 */
export function calculateSimilarity(embedding1, embedding2) {
  if (!Array.isArray(embedding1) || !Array.isArray(embedding2)) {
    throw new Error('Embeddings must be arrays');
  }

  if (embedding1.length !== embedding2.length) {
    throw new Error('Embeddings must have the same dimensions');
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i];
    norm1 += embedding1[i] * embedding1[i];
    norm2 += embedding2[i] * embedding2[i];
  }

  const magnitude = Math.sqrt(norm1) * Math.sqrt(norm2);

  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
}

/**
 * Generate SHA-256 hash of text content
 * Used to detect if content has changed and needs re-embedding
 *
 * @param {string} text - Text to hash
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function generateContentHash(text) {
  return crypto
    .createHash('sha256')
    .update(text, 'utf8')
    .digest('hex');
}

/**
 * Check if the embedding service is available
 * Useful for health checks
 *
 * @returns {Promise<boolean>}
 */
export async function isServiceAvailable() {
  try {
    await getEmbeddingPipeline();
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get service status and info
 *
 * @returns {Promise<{available: boolean, model: string, dimensions: number, loaded: boolean}>}
 */
export async function getServiceStatus() {
  const loaded = embeddingPipeline !== null;
  const available = await isServiceAvailable();

  return {
    available,
    loaded,
    model: DEFAULT_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    cacheDir: env.cacheDir,
  };
}

/**
 * Preload the model (useful for warming up on startup)
 * Call this in your server initialization to avoid cold starts
 *
 * @returns {Promise<void>}
 */
export async function preloadModel() {
  console.log('[LocalEmbedding] Preloading model...');
  await getEmbeddingPipeline();
  console.log('[LocalEmbedding] Model preloaded successfully');
}

/**
 * Validate embedding array
 *
 * @param {number[]} embedding - Embedding to validate
 * @returns {boolean}
 */
export function isValidEmbedding(embedding) {
  return (
    Array.isArray(embedding) &&
    embedding.length === EMBEDDING_DIMENSIONS &&
    embedding.every(val => typeof val === 'number' && !isNaN(val))
  );
}

// Export constants
export const CONSTANTS = {
  MODEL: DEFAULT_MODEL,
  DIMENSIONS: EMBEDDING_DIMENSIONS,
};

// Default export
export default {
  generateEmbedding,
  generateBatchEmbeddings,
  calculateSimilarity,
  generateContentHash,
  isServiceAvailable,
  getServiceStatus,
  preloadModel,
  isValidEmbedding,
  CONSTANTS,
};
