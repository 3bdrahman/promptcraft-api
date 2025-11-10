/**
 * OpenAI Provider Implementation
 * Backend implementation for OpenAI API calls
 */

import OpenAI from 'openai';
import { calculateCost } from '../config.js';

export async function generateOpenAI({ modelId, prompt, systemPrompt, maxTokens, temperature, messages }, apiKey) {
  const openai = new OpenAI({ apiKey });

  const chatMessages = [];

  if (systemPrompt) {
    chatMessages.push({ role: 'system', content: systemPrompt });
  }

  if (messages && messages.length > 0) {
    chatMessages.push(...messages);
  } else {
    chatMessages.push({ role: 'user', content: prompt });
  }

  const startTime = Date.now();

  const completion = await openai.chat.completions.create({
    model: modelId,
    messages: chatMessages,
    max_tokens: maxTokens,
    temperature: temperature
  });

  const latency = (Date.now() - startTime) / 1000;

  const output = completion.choices[0].message.content;
  const inputTokens = completion.usage.prompt_tokens;
  const outputTokens = completion.usage.completion_tokens;
  const totalTokens = completion.usage.total_tokens;
  const cost = calculateCost(modelId, inputTokens, outputTokens);

  return {
    success: true,
    output,
    model: modelId,
    modelId,
    provider: 'openai',
    inputTokens,
    outputTokens,
    totalTokens,
    cost,
    latency,
    timestamp: new Date(),
    finishReason: completion.choices[0].finish_reason
  };
}

export async function generateOpenAIEmbedding(text, modelId = 'text-embedding-3-small', apiKey) {
  const openai = new OpenAI({ apiKey });

  const response = await openai.embeddings.create({
    model: modelId,
    input: text
  });

  return {
    success: true,
    embedding: response.data[0].embedding,
    dimensions: response.data[0].embedding.length,
    model: modelId,
    provider: 'openai'
  };
}
