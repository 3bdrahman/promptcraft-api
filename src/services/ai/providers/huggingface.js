/**
 * HuggingFace Provider Implementation
 * Backend implementation for HuggingFace Inference API calls
 */

import { calculateCost, estimateTokens } from '../config.js';

export async function generateHuggingFace({ modelId, prompt, systemPrompt, maxTokens, temperature }, apiKey) {
  const input = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

  const startTime = Date.now();

  const response = await fetch(
    `https://api-inference.huggingface.co/models/${modelId}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: input,
        parameters: {
          max_new_tokens: maxTokens,
          temperature: temperature,
          return_full_text: false,
          do_sample: temperature > 0
        }
      })
    }
  );

  const latency = (Date.now() - startTime) / 1000;

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));

    // Handle model loading state
    if (response.status === 503 && errorData.error?.includes('loading')) {
      throw new Error(
        'Model is currently loading. This usually takes 20-30 seconds. Please try again shortly.'
      );
    }

    throw new Error(
      errorData.error || `HuggingFace API error: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  // HuggingFace returns array of results
  const output = Array.isArray(data) && data[0]?.generated_text
    ? data[0].generated_text
    : data.generated_text || '';

  const inputTokens = estimateTokens(input);
  const outputTokens = estimateTokens(output);
  const totalTokens = inputTokens + outputTokens;
  const cost = calculateCost(modelId, inputTokens, outputTokens);

  return {
    success: true,
    output,
    model: modelId,
    modelId,
    provider: 'huggingface',
    inputTokens,
    outputTokens,
    totalTokens,
    cost,
    latency,
    timestamp: new Date()
  };
}

export async function generateHuggingFaceEmbedding(text, modelId = 'sentence-transformers/all-MiniLM-L6-v2', apiKey) {
  const response = await fetch(
    `https://api-inference.huggingface.co/pipeline/feature-extraction/${modelId}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ inputs: text })
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.error || `HuggingFace embedding error: ${response.status}`
    );
  }

  const embeddings = await response.json();

  // HuggingFace returns nested arrays, we need to flatten
  const embedding = Array.isArray(embeddings) && Array.isArray(embeddings[0])
    ? embeddings[0]
    : embeddings;

  return {
    success: true,
    embedding,
    dimensions: embedding.length,
    model: modelId,
    provider: 'huggingface'
  };
}
