-- Patch: Add conversation tables for AI-assisted context building
-- These tables store conversational sessions for the conversational builder feature

-- Create conversation_sessions table
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL DEFAULT 'active', -- active, completed, abandoned
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create conversation_messages table
CREATE TABLE IF NOT EXISTS conversation_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL, -- 'user' or 'assistant'
  content TEXT NOT NULL,
  contexts_generated JSONB DEFAULT '[]',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_user ON conversation_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_status ON conversation_sessions(status);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_session ON conversation_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_timestamp ON conversation_messages(timestamp);

-- Add comments
COMMENT ON TABLE conversation_sessions IS 'Conversational sessions for AI-assisted context building';
COMMENT ON TABLE conversation_messages IS 'Messages exchanged in a conversation session';
