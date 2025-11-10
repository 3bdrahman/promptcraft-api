/**
 * Embedding Service - Stub for now
 * TODO: Implement when configuring AI providers
 */

export async function generateEmbedding(text) {
  // Placeholder - returns null until we configure OpenAI/HuggingFace
  return null;
}

export async function calculateSimilarity(embedding1, embedding2) {
  // Placeholder
  return 0;
}

export default {
  generateEmbedding,
  calculateSimilarity
};
