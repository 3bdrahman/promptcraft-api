-- Migration: Setup pgvector Extension and Embeddings Infrastructure
-- Description: Enable vector similarity search for templates and contexts
-- Author: PromptCraft Team
-- Date: 2025-11-16

-- ============================================================================
-- PART 1: Install pgvector Extension
-- ============================================================================

-- Create pgvector extension (requires superuser or rds_superuser role)
-- For cloud databases (Neon, Supabase), this may already be available
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify extension is loaded
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'vector'
  ) THEN
    RAISE EXCEPTION 'pgvector extension not installed. Please install it first.';
  END IF;
END
$$;

-- ============================================================================
-- PART 2: Create Embeddings Tables
-- ============================================================================

-- Embeddings for context layers
-- Using local model: Xenova/all-MiniLM-L6-v2 (384 dimensions)
-- Runs locally via Transformers.js - no external API calls!
CREATE TABLE IF NOT EXISTS context_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id UUID NOT NULL REFERENCES context_layers(id) ON DELETE CASCADE,
  embedding vector(384), -- all-MiniLM-L6-v2 local model (384 dims)
  content_hash TEXT NOT NULL, -- SHA-256 hash to detect content changes
  model_id VARCHAR(100) NOT NULL DEFAULT 'Xenova/all-MiniLM-L6-v2',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  -- Ensure one embedding per context
  UNIQUE(context_id)
);

-- Embeddings for templates
CREATE TABLE IF NOT EXISTS template_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  embedding vector(384), -- all-MiniLM-L6-v2 local model (384 dims)
  content_hash TEXT NOT NULL, -- SHA-256 hash to detect content changes
  model_id VARCHAR(100) NOT NULL DEFAULT 'Xenova/all-MiniLM-L6-v2',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(template_id)
);

-- Embedding generation queue for async processing
CREATE TABLE IF NOT EXISTS embedding_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type VARCHAR(50) NOT NULL, -- 'context' or 'template'
  resource_id UUID NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5, -- 1 (highest) to 10 (lowest)
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  retry_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,

  -- Prevent duplicate queue entries
  UNIQUE(resource_type, resource_id, status)
);

-- ============================================================================
-- PART 3: Create Vector Indexes for Fast Similarity Search
-- ============================================================================

-- HNSW index for context embeddings (faster than IVFFlat for < 1M vectors)
-- Using cosine distance (1 - cosine similarity)
-- m = 16: number of bi-directional links per node (higher = better recall, more memory)
-- ef_construction = 64: size of dynamic candidate list (higher = better index quality, slower build)
CREATE INDEX IF NOT EXISTS idx_context_embeddings_hnsw
  ON context_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- HNSW index for template embeddings
CREATE INDEX IF NOT EXISTS idx_template_embeddings_hnsw
  ON template_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ============================================================================
-- PART 4: Create Supporting Indexes
-- ============================================================================

-- Index for queue processing (fetch pending jobs by priority)
CREATE INDEX IF NOT EXISTS idx_embedding_queue_processing
  ON embedding_queue(status, priority, created_at)
  WHERE status = 'pending';

-- Index for content hash lookups (detect unchanged content)
CREATE INDEX IF NOT EXISTS idx_context_embeddings_hash
  ON context_embeddings(content_hash);

CREATE INDEX IF NOT EXISTS idx_template_embeddings_hash
  ON template_embeddings(content_hash);

-- Index for resource ID lookups
CREATE INDEX IF NOT EXISTS idx_context_embeddings_context_id
  ON context_embeddings(context_id);

CREATE INDEX IF NOT EXISTS idx_template_embeddings_template_id
  ON template_embeddings(template_id);

-- ============================================================================
-- PART 5: Create Trigger Functions for Auto-Queue on Updates
-- ============================================================================

-- Function to queue context embedding generation when content changes
CREATE OR REPLACE FUNCTION queue_context_embedding()
RETURNS TRIGGER AS $$
BEGIN
  -- Only queue if content actually changed
  IF (TG_OP = 'INSERT') OR (NEW.content IS DISTINCT FROM OLD.content) THEN
    INSERT INTO embedding_queue (resource_type, resource_id, priority)
    VALUES ('context', NEW.id, 5)
    ON CONFLICT (resource_type, resource_id, status)
    DO NOTHING; -- Avoid duplicate queue entries
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to queue template embedding generation when content changes
CREATE OR REPLACE FUNCTION queue_template_embedding()
RETURNS TRIGGER AS $$
BEGIN
  -- Only queue if content actually changed
  IF (TG_OP = 'INSERT') OR (NEW.content IS DISTINCT FROM OLD.content) THEN
    INSERT INTO embedding_queue (resource_type, resource_id, priority)
    VALUES ('template', NEW.id, 5)
    ON CONFLICT (resource_type, resource_id, status)
    DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PART 6: Create Triggers for Auto-Queueing
-- ============================================================================

-- Trigger for context layers
DROP TRIGGER IF EXISTS trigger_queue_context_embedding ON context_layers;
CREATE TRIGGER trigger_queue_context_embedding
  AFTER INSERT OR UPDATE OF content ON context_layers
  FOR EACH ROW
  EXECUTE FUNCTION queue_context_embedding();

-- Trigger for templates
DROP TRIGGER IF EXISTS trigger_queue_template_embedding ON templates;
CREATE TRIGGER trigger_queue_template_embedding
  AFTER INSERT OR UPDATE OF content ON templates
  FOR EACH ROW
  EXECUTE FUNCTION queue_template_embedding();

-- ============================================================================
-- PART 7: Create Updated_At Triggers
-- ============================================================================

CREATE OR REPLACE FUNCTION update_embedding_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_context_embeddings_updated_at ON context_embeddings;
CREATE TRIGGER trigger_context_embeddings_updated_at
  BEFORE UPDATE ON context_embeddings
  FOR EACH ROW
  EXECUTE FUNCTION update_embedding_timestamp();

DROP TRIGGER IF EXISTS trigger_template_embeddings_updated_at ON template_embeddings;
CREATE TRIGGER trigger_template_embeddings_updated_at
  BEFORE UPDATE ON template_embeddings
  FOR EACH ROW
  EXECUTE FUNCTION update_embedding_timestamp();

-- ============================================================================
-- PART 8: Grant Permissions (adjust role as needed)
-- ============================================================================

-- Grant permissions to your API user (replace 'api_user' with your actual role)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON context_embeddings TO api_user;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON template_embeddings TO api_user;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON embedding_queue TO api_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api_user;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

-- Verify tables were created
DO $$
DECLARE
  table_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO table_count
  FROM information_schema.tables
  WHERE table_name IN ('context_embeddings', 'template_embeddings', 'embedding_queue');

  IF table_count < 3 THEN
    RAISE EXCEPTION 'Not all embedding tables were created!';
  END IF;

  RAISE NOTICE 'Migration completed successfully! Created % tables.', table_count;
END
$$;

-- Show created indexes
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename IN ('context_embeddings', 'template_embeddings', 'embedding_queue')
ORDER BY tablename, indexname;
