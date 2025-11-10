/**
 * Google AI Provider Implementation
 * Backend implementation for Google Gemini API calls
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { calculateCost, estimateTokens } from '../config.js';

export async function generateGoogle({ modelId, prompt, systemPrompt, maxTokens, temperature, messages }, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelId });

  let fullPrompt = prompt;
  if (systemPrompt) {
    fullPrompt = `${systemPrompt}\n\n${prompt}`;
  }

  const startTime = Date.now();

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
    generationConfig: {
      temperature: temperature,
      maxOutputTokens: maxTokens
    }
  });

  const latency = (Date.now() - startTime) / 1000;

  const response = result.response;
  const output = response.text();

  // Google provides usage metadata
  const inputTokens = response.usageMetadata?.promptTokenCount || estimateTokens(fullPrompt);
  const outputTokens = response.usageMetadata?.candidatesTokenCount || estimateTokens(output);
  const totalTokens = response.usageMetadata?.totalTokenCount || inputTokens + outputTokens;
  const cost = calculateCost(modelId, inputTokens, outputTokens);

  return {
    success: true,
    output,
    model: modelId,
    modelId,
    provider: 'google',
    inputTokens,
    outputTokens,
    totalTokens,
    cost,
    latency,
    timestamp: new Date(),
    finishReason: response.candidates?.[0]?.finishReason
  };
}
