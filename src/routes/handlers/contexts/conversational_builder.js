/**
 * Conversational Context Builder Handler
 *
 * AI-powered conversational interface for building contexts through natural dialogue
 *
 * @module handlers/contexts/conversational_builder
 */

import { db } from '../../../utils/database.js';
import { getUserId } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// Initialize AI clients
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

/**
 * POST /api/contexts/conversation/start
 * Start a new conversational context building session
 *
 * Body:
 * - initial_message: (optional) User's initial message
 * - preferences: (optional) User preferences for AI behavior
 */
export async function startConversation(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      initial_message = null,
      preferences = {}
    } = req.body;

    // Create conversation session in database
    const result = await db.query(
      `INSERT INTO conversation_sessions
       (user_id, status, metadata, created_at, updated_at)
       VALUES ($1, 'active', $2, NOW(), NOW())
       RETURNING id, created_at, status`,
      [userId, JSON.stringify(preferences)]
    );

    const session = result.rows[0];

    // Generate initial AI greeting
    const greeting = initial_message
      ? await generateAIResponse(session.id, userId, initial_message, 'start')
      : {
          message: "Hello! I'm here to help you create perfect contexts. What would you like to build today? You can describe:\n\n• A project you're working on\n• A specific task or workflow\n• Technical documentation you need\n• Or anything else you'd like context for!\n\nJust tell me in your own words, and I'll help structure it into useful contexts.",
          contexts: [],
          suggestions: [
            "I'm working on a React application",
            "I need contexts for writing documentation",
            "Help me organize my project contexts"
          ],
          is_complete: false
        };

    // Save initial message if provided
    if (initial_message) {
      await db.query(
        `INSERT INTO conversation_messages
         (session_id, role, content, contexts_generated, timestamp)
         VALUES ($1, 'user', $2, '[]', NOW())`,
        [session.id, initial_message]
      );

      await db.query(
        `INSERT INTO conversation_messages
         (session_id, role, content, contexts_generated, timestamp)
         VALUES ($1, 'assistant', $2, $3, NOW())`,
        [session.id, greeting.message, JSON.stringify(greeting.contexts)]
      );
    }

    return res.json(success({
      session_id: session.id,
      created_at: session.created_at,
      message: greeting.message,
      contexts: greeting.contexts,
      suggestions: greeting.suggestions,
      is_complete: greeting.is_complete
    }));

  } catch (err) {
    console.error('Start conversation error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/conversation/message
 * Send a message in an ongoing conversation
 *
 * Body:
 * - session_id: Conversation session ID
 * - message: User's message
 * - current_contexts: (optional) Current contexts in the session
 */
export async function sendMessage(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      session_id,
      message: userMessage,
      current_contexts = []
    } = req.body;

    if (!session_id || !userMessage) {
      return res.status(400).json(error('session_id and message are required'));
    }

    // Verify session belongs to user
    const sessionCheck = await db.query(
      `SELECT id, status FROM conversation_sessions
       WHERE id = $1 AND user_id = $2`,
      [session_id, userId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json(error('Conversation session not found', 404));
    }

    if (sessionCheck.rows[0].status !== 'active') {
      return res.status(400).json(error('Conversation session is not active'));
    }

    // Save user message
    await db.query(
      `INSERT INTO conversation_messages
       (session_id, role, content, contexts_generated, timestamp)
       VALUES ($1, 'user', $2, '[]', NOW())`,
      [session_id, userMessage]
    );

    // Generate AI response with context extraction
    const aiResponse = await generateAIResponse(
      session_id,
      userId,
      userMessage,
      'continue',
      current_contexts
    );

    // Save assistant message
    await db.query(
      `INSERT INTO conversation_messages
       (session_id, role, content, contexts_generated, timestamp)
       VALUES ($1, 'assistant', $2, $3, NOW())`,
      [session_id, aiResponse.message, JSON.stringify(aiResponse.contexts)]
    );

    // Update session timestamp
    await db.query(
      `UPDATE conversation_sessions
       SET updated_at = NOW()
       WHERE id = $1`,
      [session_id]
    );

    return res.json(success({
      session_id,
      message: aiResponse.message,
      contexts: aiResponse.contexts,
      suggestions: aiResponse.suggestions,
      is_complete: aiResponse.is_complete
    }));

  } catch (err) {
    console.error('Send message error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/contexts/conversation/save
 * Save contexts from a conversation session
 *
 * Body:
 * - session_id: Conversation session ID
 * - contexts: Array of contexts to save
 * - generate_embeddings: (optional) Generate embeddings immediately
 */
export async function saveConversationContexts(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      session_id,
      contexts: contextsToSave,
      generate_embeddings = true
    } = req.body;

    if (!session_id || !contextsToSave || !Array.isArray(contextsToSave)) {
      return res.status(400).json(error('session_id and contexts array are required'));
    }

    // Verify session belongs to user
    const sessionCheck = await db.query(
      `SELECT id FROM conversation_sessions
       WHERE id = $1 AND user_id = $2`,
      [session_id, userId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json(error('Conversation session not found', 404));
    }

    const savedContexts = [];

    // Save each context
    for (const context of contextsToSave) {
      const result = await db.query(
        `INSERT INTO context_layers
         (user_id, name, description, content, layer_type, tags, metadata, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW(), NOW())
         RETURNING context_id, name, description, content, layer_type, tags, created_at`,
        [
          userId,
          context.name,
          context.description || '',
          context.content,
          context.layer_type || 'adhoc',
          context.tags || [],
          JSON.stringify({
            source: 'conversational_builder',
            session_id,
            ...context.metadata
          })
        ]
      );

      const saved = result.rows[0];
      savedContexts.push(saved);

      // Queue embedding generation if requested
      if (generate_embeddings) {
        await db.query(
          `INSERT INTO embedding_queue
           (context_id, user_id, status, priority, created_at)
           VALUES ($1, $2, 'pending', 1, NOW())
           ON CONFLICT (context_id) DO NOTHING`,
          [saved.context_id, userId]
        );
      }
    }

    // Mark conversation as completed
    await db.query(
      `UPDATE conversation_sessions
       SET status = 'completed', updated_at = NOW()
       WHERE id = $1`,
      [session_id]
    );

    return res.json(success({
      saved_count: savedContexts.length,
      contexts: savedContexts,
      session_id,
      embeddings_queued: generate_embeddings
    }));

  } catch (err) {
    console.error('Save conversation contexts error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * GET /api/contexts/conversation/:sessionId
 * Get conversation history
 */
export async function getConversationHistory(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const { sessionId } = req.params;

    // Get session
    const sessionResult = await db.query(
      `SELECT id, created_at, updated_at, status, metadata
       FROM conversation_sessions
       WHERE id = $1 AND user_id = $2`,
      [sessionId, userId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json(error('Conversation not found', 404));
    }

    const session = sessionResult.rows[0];

    // Get messages
    const messagesResult = await db.query(
      `SELECT role, content, contexts_generated, timestamp
       FROM conversation_messages
       WHERE session_id = $1
       ORDER BY timestamp ASC`,
      [sessionId]
    );

    return res.json(success({
      session: {
        id: session.id,
        created_at: session.created_at,
        updated_at: session.updated_at,
        status: session.status,
        metadata: session.metadata
      },
      messages: messagesResult.rows.map(msg => ({
        role: msg.role,
        content: msg.content,
        contexts: msg.contexts_generated,
        timestamp: msg.timestamp
      }))
    }));

  } catch (err) {
    console.error('Get conversation history error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * Generate AI response using OpenAI or Anthropic
 */
async function generateAIResponse(sessionId, userId, userMessage, stage, currentContexts = []) {
  try {
    // Get conversation history
    const messages = await db.query(
      `SELECT role, content
       FROM conversation_messages
       WHERE session_id = $1
       ORDER BY timestamp ASC`,
      [sessionId]
    );

    const conversationHistory = messages.rows.map(m => ({
      role: m.role,
      content: m.content
    }));

    // Build system prompt
    const systemPrompt = buildSystemPrompt(stage, currentContexts);

    // Try Claude first (better at structured output)
    if (anthropic) {
      return await generateClaudeResponse(systemPrompt, conversationHistory, userMessage);
    }

    // Fallback to OpenAI
    if (openai) {
      return await generateOpenAIResponse(systemPrompt, conversationHistory, userMessage);
    }

    // No AI provider available
    throw new Error('No AI provider configured. Please set OPENAI_API_KEY or ANTHROPIC_API_KEY');

  } catch (err) {
    console.error('Generate AI response error:', err);
    // Return fallback response
    return {
      message: "I'm having trouble connecting to the AI service right now. Please try again in a moment.",
      contexts: [],
      suggestions: [],
      is_complete: false
    };
  }
}

/**
 * Generate response using Claude (Anthropic)
 */
async function generateClaudeResponse(systemPrompt, history, userMessage) {
  const response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [
      ...history,
      { role: 'user', content: userMessage }
    ]
  });

  const content = response.content[0].text;

  // Parse response (expecting JSON)
  try {
    const parsed = JSON.parse(content);
    return {
      message: parsed.message || content,
      contexts: parsed.contexts || [],
      suggestions: parsed.suggestions || [],
      is_complete: parsed.is_complete || false
    };
  } catch (e) {
    // If not JSON, treat as plain message
    return {
      message: content,
      contexts: [],
      suggestions: [],
      is_complete: false
    };
  }
}

/**
 * Generate response using OpenAI
 */
async function generateOpenAIResponse(systemPrompt, history, userMessage) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4-turbo-preview',
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7
  });

  const content = response.choices[0].message.content;
  const parsed = JSON.parse(content);

  return {
    message: parsed.message || '',
    contexts: parsed.contexts || [],
    suggestions: parsed.suggestions || [],
    is_complete: parsed.is_complete || false
  };
}

/**
 * Build system prompt based on conversation stage
 */
function buildSystemPrompt(stage, currentContexts = []) {
  const basePrompt = `You are an expert context engineering assistant. Your job is to help users create perfect contexts for their prompts through natural conversation.

RESPONSE FORMAT:
Always respond with valid JSON in this exact format:
{
  "message": "Your conversational response to the user",
  "contexts": [
    {
      "name": "Context Name",
      "description": "Brief description",
      "content": "The actual context content",
      "layer_type": "project|task|profile|snippet|adhoc",
      "tags": ["tag1", "tag2"],
      "metadata": {}
    }
  ],
  "suggestions": ["Suggestion 1", "Suggestion 2"],
  "is_complete": false
}

GUIDELINES:
1. Be conversational and friendly
2. Ask clarifying questions to understand user needs
3. Extract contexts incrementally - don't wait for all information
4. Create well-structured, reusable contexts
5. Use appropriate layer_type based on context purpose
6. Add relevant tags for organization
7. Set is_complete to true when user seems satisfied

CONTEXT TYPES:
- profile: User background, preferences, style guides
- project: Project-specific information
- task: Specific task instructions
- snippet: Reusable code/text snippets
- adhoc: One-off or temporary contexts`;

  if (stage === 'start') {
    return basePrompt + `\n\nThis is the start of a new conversation. Be welcoming and help the user get started.`;
  }

  if (currentContexts.length > 0) {
    return basePrompt + `\n\nCURRENT CONTEXTS:\n${JSON.stringify(currentContexts, null, 2)}\n\nContinue helping the user refine or add to these contexts.`;
  }

  return basePrompt;
}

export default {
  startConversation,
  sendMessage,
  saveConversationContexts,
  getConversationHistory
};
