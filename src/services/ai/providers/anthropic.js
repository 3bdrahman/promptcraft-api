/**
 * Anthropic Provider Implementation
 * Backend implementation for Anthropic Claude API calls
 */

import Anthropic from '@anthropic-ai/sdk';
import { calculateCost } from '../config.js';

export async function generateAnthropic({ modelId, prompt, systemPrompt, maxTokens, temperature, messages }, apiKey) {
  const anthropic = new Anthropic({ apiKey });

  const chatMessages = messages && messages.length > 0
    ? messages
    : [{ role: 'user', content: prompt }];

  const requestBody = {
    model: modelId,
    messages: chatMessages,
    max_tokens: maxTokens,
    temperature: temperature
  };

  if (systemPrompt) {
    requestBody.system = systemPrompt;
  }

  const startTime = Date.now();

  const response = await anthropic.messages.create(requestBody);

  const latency = (Date.now() - startTime) / 1000;

  const output = response.content[0].text;
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const totalTokens = inputTokens + outputTokens;
  const cost = calculateCost(modelId, inputTokens, outputTokens);

  return {
    success: true,
    output,
    model: modelId,
    modelId,
    provider: 'anthropic',
    inputTokens,
    outputTokens,
    totalTokens,
    cost,
    latency,
    timestamp: new Date(),
    stopReason: response.stop_reason
  };
}
