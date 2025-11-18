/**
 * Database Migration: Revolutionary Features
 *
 * Adds tables and indexes for:
 * 1. Conversational Context Builder
 * 2. Context Extraction
 * 3. Predictive Context Engine
 * 4. Compression Engine
 * 5. Knowledge Graph (uses existing embeddings)
 *
 * Run this migration on your PostgreSQL database to enable revolutionary features
 */

-- =============================================
-- CONVERSATIONAL CONTEXT BUILDER
-- =============================================

-- Conversation sessions table
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'completed', 'abandoned'
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Conversation messages table
CREATE TABLE IF NOT EXISTS conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- 'user', 'assistant'
  content TEXT NOT NULL,
  contexts_generated JSONB DEFAULT '[]'::jsonb,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for conversation tables
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_user
  ON conversation_sessions(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_status
  ON conversation_sessions(status);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_session
  ON conversation_messages(session_id, timestamp ASC);

-- =============================================
-- PREDICTIVE CONTEXT ENGINE
-- =============================================

-- Context usage events table for pattern tracking
CREATE TABLE IF NOT EXISTS context_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  context_id UUID NOT NULL REFERENCES context_layers(context_id) ON DELETE CASCADE,
  activity_type TEXT, -- 'frontend', 'backend', 'documentation', etc.
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  success BOOLEAN DEFAULT TRUE,
  duration INTEGER, -- Session duration in seconds
  metadata JSONB DEFAULT '{}'::jsonb -- Stores hour, day_of_week, related_contexts, etc.
);

-- Indexes for pattern analysis
CREATE INDEX IF NOT EXISTS idx_usage_events_user_time
  ON context_usage_events(user_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_context
  ON context_usage_events(context_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_activity
  ON context_usage_events(activity_type, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_metadata
  ON context_usage_events USING GIN (metadata);

-- Add usage tracking columns to context_layers if they don't exist
ALTER TABLE context_layers
  ADD COLUMN IF NOT EXISTS usage_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP WITH TIME ZONE;

-- =============================================
-- COMPRESSION ENGINE
-- =============================================

-- Context backups table (for compression and other modifications)
CREATE TABLE IF NOT EXISTS context_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id UUID NOT NULL REFERENCES context_layers(context_id) ON DELETE CASCADE,
  original_content TEXT NOT NULL,
  original_tokens INTEGER,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  reason TEXT -- 'compression', 'merge', 'edit'
);

-- Compression analytics table
CREATE TABLE IF NOT EXISTS compression_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  context_id UUID NOT NULL REFERENCES context_layers(context_id) ON DELETE CASCADE,
  original_tokens INTEGER NOT NULL,
  compressed_tokens INTEGER NOT NULL,
  tokens_saved INTEGER NOT NULL,
  quality_score FLOAT, -- Semantic similarity score 0-1
  mode TEXT, -- 'aggressive', 'balanced', 'conservative'
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for compression analytics
CREATE INDEX IF NOT EXISTS idx_compression_analytics_user_time
  ON compression_analytics(user_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_compression_analytics_context
  ON compression_analytics(context_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_context_backups_context
  ON context_backups(context_id, created_at DESC);

-- Add token_count column to context_layers if it doesn't exist
ALTER TABLE context_layers
  ADD COLUMN IF NOT EXISTS token_count INTEGER;

-- Add metadata column to context_layers if it doesn't exist
ALTER TABLE context_layers
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- =============================================
-- KNOWLEDGE GRAPH (uses existing embeddings)
-- =============================================
-- No new tables needed - knowledge graph uses existing:
-- - context_layers
-- - context_embeddings
-- - Similarity calculations via pgvector

-- =============================================
-- HELPER FUNCTIONS
-- =============================================

-- Function to update conversation session timestamp
CREATE OR REPLACE FUNCTION update_conversation_session_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversation_sessions
  SET updated_at = NOW()
  WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update conversation session timestamp
DROP TRIGGER IF EXISTS trigger_update_conversation_timestamp ON conversation_messages;
CREATE TRIGGER trigger_update_conversation_timestamp
  AFTER INSERT ON conversation_messages
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_session_timestamp();

-- Function to increment context usage count
CREATE OR REPLACE FUNCTION increment_context_usage()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE context_layers
  SET usage_count = COALESCE(usage_count, 0) + 1,
      last_used_at = NEW.timestamp
  WHERE context_id = NEW.context_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-increment usage count
DROP TRIGGER IF EXISTS trigger_increment_context_usage ON context_usage_events;
CREATE TRIGGER trigger_increment_context_usage
  AFTER INSERT ON context_usage_events
  FOR EACH ROW
  EXECUTE FUNCTION increment_context_usage();

-- =============================================
-- VIEWS FOR ANALYTICS
-- =============================================

-- View: Context usage patterns
CREATE OR REPLACE VIEW context_usage_patterns AS
SELECT
  user_id,
  context_id,
  COUNT(*) as total_uses,
  COUNT(DISTINCT DATE_TRUNC('day', timestamp)) as days_used,
  AVG(CASE WHEN success THEN 1 ELSE 0 END) as success_rate,
  AVG(duration) as avg_duration,
  MAX(timestamp) as last_used,
  MIN(timestamp) as first_used
FROM context_usage_events
GROUP BY user_id, context_id;

-- View: Hourly usage patterns
CREATE OR REPLACE VIEW hourly_usage_patterns AS
SELECT
  user_id,
  EXTRACT(HOUR FROM timestamp) as hour,
  COUNT(*) as usage_count,
  COUNT(DISTINCT context_id) as unique_contexts,
  AVG(CASE WHEN success THEN 1 ELSE 0 END) as success_rate
FROM context_usage_events
GROUP BY user_id, EXTRACT(HOUR FROM timestamp);

-- View: Compression savings summary
CREATE OR REPLACE VIEW compression_savings_summary AS
SELECT
  user_id,
  COUNT(*) as total_compressions,
  SUM(original_tokens) as total_original_tokens,
  SUM(compressed_tokens) as total_compressed_tokens,
  SUM(tokens_saved) as total_tokens_saved,
  AVG(quality_score) as avg_quality_score,
  MAX(timestamp) as last_compression
FROM compression_analytics
GROUP BY user_id;

-- =============================================
-- INITIAL DATA / DEFAULTS
-- =============================================

-- Add default activity types (optional - for documentation)
COMMENT ON COLUMN context_usage_events.activity_type IS
  'Activity types: frontend, backend, database, documentation, api, testing, debugging, planning, other';

COMMENT ON COLUMN compression_analytics.mode IS
  'Compression modes: aggressive (50-60% savings, 90% preservation), balanced (30-40% savings, 95% preservation), conservative (15-25% savings, 98% preservation)';

-- =============================================
-- GRANTS (adjust based on your user setup)
-- =============================================

-- If you have specific app users, grant permissions:
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO your_app_user;
-- GRANT SELECT ON ALL VIEWS IN SCHEMA public TO your_app_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO your_app_user;

-- =============================================
-- MIGRATION COMPLETE
-- =============================================

-- Verify tables created
DO $$
DECLARE
  table_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO table_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'conversation_sessions',
      'conversation_messages',
      'context_usage_events',
      'context_backups',
      'compression_analytics'
    );

  IF table_count = 5 THEN
    RAISE NOTICE '✅ Migration successful! All 5 tables created.';
    RAISE NOTICE 'Tables: conversation_sessions, conversation_messages, context_usage_events, context_backups, compression_analytics';
  ELSE
    RAISE WARNING '⚠️  Expected 5 tables, found %. Please review migration.', table_count;
  END IF;
END $$;
