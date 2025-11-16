-- Migration: Vector Similarity Search Functions
-- Description: PostgreSQL functions for semantic search and recommendations
-- Author: PromptCraft Team
-- Date: 2025-11-16

-- ============================================================================
-- IMPORTANT: Drop existing functions first to avoid conflicts
-- ============================================================================

-- Drop existing functions if they exist (CASCADE removes dependent objects)
DROP FUNCTION IF EXISTS find_similar_contexts(vector, uuid, integer, numeric, uuid[]) CASCADE;
DROP FUNCTION IF EXISTS find_similar_templates(vector, uuid, integer, numeric, uuid[]) CASCADE;
DROP FUNCTION IF EXISTS get_learned_recommendations(uuid, vector, text, integer) CASCADE;
DROP FUNCTION IF EXISTS get_context_effectiveness(uuid, integer) CASCADE;
DROP FUNCTION IF EXISTS get_context_associations(uuid, uuid, integer) CASCADE;
DROP FUNCTION IF EXISTS hybrid_search_contexts(text, vector, uuid, integer, numeric) CASCADE;

-- ============================================================================
-- PART 1: Similarity Search for Contexts
-- ============================================================================

/**
 * Find similar context layers based on embedding similarity
 *
 * @param query_embedding - The query embedding vector
 * @param user_id - User ID to filter contexts (can be NULL for public search)
 * @param result_limit - Maximum number of results to return
 * @param min_similarity - Minimum similarity threshold (0.0 to 1.0)
 * @param exclude_ids - Array of context IDs to exclude from results
 *
 * @returns Table of similar contexts with similarity scores
 */
CREATE OR REPLACE FUNCTION find_similar_contexts(
  query_embedding vector(384),
  user_id UUID DEFAULT NULL,
  result_limit INT DEFAULT 10,
  min_similarity DECIMAL DEFAULT 0.7,
  exclude_ids UUID[] DEFAULT ARRAY[]::UUID[]
)
RETURNS TABLE (
  context_id UUID,
  name VARCHAR,
  description TEXT,
  content TEXT,
  layer_type VARCHAR,
  tags TEXT[],
  visibility VARCHAR,
  team_id UUID,
  similarity DECIMAL,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cl.id AS context_id,
    cl.name,
    cl.description,
    cl.content,
    cl.layer_type,
    cl.tags,
    cl.visibility,
    cl.team_id,
    -- Calculate cosine similarity (1 - cosine distance)
    -- pgvector uses <=> for cosine distance, so similarity = 1 - distance
    (1 - (ce.embedding <=> query_embedding))::DECIMAL AS similarity,
    cl.created_at,
    cl.updated_at
  FROM
    context_layers cl
  INNER JOIN
    context_embeddings ce ON cl.id = ce.context_id
  WHERE
    -- Exclude soft-deleted contexts
    cl.deleted_at IS NULL
    -- Exclude specified IDs
    AND (array_length(exclude_ids, 1) IS NULL OR cl.id != ALL(exclude_ids))
    -- Filter by similarity threshold
    AND (1 - (ce.embedding <=> query_embedding)) >= min_similarity
    -- Filter by user access (own contexts, team contexts, or public)
    AND (
      user_id IS NULL -- Public search
      OR cl.user_id = user_id -- User's own contexts
      OR cl.visibility = 'public' -- Public contexts
      OR (cl.team_id IS NOT NULL AND EXISTS (
        -- Team contexts user has access to
        SELECT 1 FROM team_members tm
        WHERE tm.team_id = cl.team_id AND tm.user_id = user_id
      ))
    )
  ORDER BY
    similarity DESC
  LIMIT
    result_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- PART 2: Similarity Search for Templates
-- ============================================================================

/**
 * Find similar templates based on embedding similarity
 *
 * @param query_embedding - The query embedding vector
 * @param user_id - User ID to filter templates
 * @param result_limit - Maximum number of results
 * @param min_similarity - Minimum similarity threshold
 * @param exclude_ids - Array of template IDs to exclude
 *
 * @returns Table of similar templates with similarity scores
 */
CREATE OR REPLACE FUNCTION find_similar_templates(
  query_embedding vector(384),
  user_id UUID DEFAULT NULL,
  result_limit INT DEFAULT 10,
  min_similarity DECIMAL DEFAULT 0.7,
  exclude_ids UUID[] DEFAULT ARRAY[]::UUID[]
)
RETURNS TABLE (
  template_id UUID,
  name VARCHAR,
  description TEXT,
  content TEXT,
  category VARCHAR,
  tags TEXT[],
  visibility VARCHAR,
  team_id UUID,
  similarity DECIMAL,
  likes_count INTEGER,
  usage_count INTEGER,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id AS template_id,
    t.name,
    t.description,
    t.content,
    t.category,
    t.tags,
    t.visibility,
    t.team_id,
    (1 - (te.embedding <=> query_embedding))::DECIMAL AS similarity,
    t.likes_count,
    t.usage_count,
    t.created_at,
    t.updated_at
  FROM
    templates t
  INNER JOIN
    template_embeddings te ON t.id = te.template_id
  WHERE
    t.deleted_at IS NULL
    AND (array_length(exclude_ids, 1) IS NULL OR t.id != ALL(exclude_ids))
    AND (1 - (te.embedding <=> query_embedding)) >= min_similarity
    AND (
      user_id IS NULL
      OR t.user_id = user_id
      OR t.visibility = 'public'
      OR (t.team_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM team_members tm
        WHERE tm.team_id = t.team_id AND tm.user_id = user_id
      ))
    )
  ORDER BY
    similarity DESC
  LIMIT
    result_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- PART 3: AI-Powered Recommendations Based on Usage Patterns
-- ============================================================================

/**
 * Get learned recommendations based on collaborative filtering
 * Finds contexts that are frequently used together with similar contexts
 *
 * @param user_id - User ID for personalized recommendations
 * @param query_embedding - Optional query embedding for hybrid search
 * @param prompt_text - Optional prompt text for additional filtering
 * @param result_limit - Maximum number of recommendations
 *
 * @returns Table of recommended contexts with scores
 */
CREATE OR REPLACE FUNCTION get_learned_recommendations(
  user_id UUID,
  query_embedding vector(384) DEFAULT NULL,
  prompt_text TEXT DEFAULT NULL,
  result_limit INT DEFAULT 10
)
RETURNS TABLE (
  context_id UUID,
  name VARCHAR,
  description TEXT,
  layer_type VARCHAR,
  recommendation_score DECIMAL,
  usage_count BIGINT,
  avg_rating DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  WITH user_recent_contexts AS (
    -- Get contexts the user has recently used
    SELECT DISTINCT ur.context_id
    FROM usage_relationships ur
    WHERE ur.user_id = user_id
    ORDER BY ur.created_at DESC
    LIMIT 20
  ),
  co_occurring_contexts AS (
    -- Find contexts frequently used together with user's recent contexts
    SELECT
      ur2.context_id,
      COUNT(*) AS co_occurrence_count
    FROM
      usage_relationships ur1
    INNER JOIN
      usage_relationships ur2 ON ur1.template_id = ur2.template_id
    WHERE
      ur1.context_id IN (SELECT context_id FROM user_recent_contexts)
      AND ur2.context_id NOT IN (SELECT context_id FROM user_recent_contexts)
      AND ur2.user_id = user_id
    GROUP BY
      ur2.context_id
    HAVING
      COUNT(*) >= 2 -- Appeared together at least twice
  ),
  context_stats AS (
    -- Calculate statistics for each context
    SELECT
      cl.id,
      cl.name,
      cl.description,
      cl.layer_type,
      cl.usage_count,
      COALESCE(AVG(r.rating), 0) AS avg_rating,
      ce.embedding
    FROM
      context_layers cl
    LEFT JOIN
      context_embeddings ce ON cl.id = ce.context_id
    LEFT JOIN
      (SELECT context_id, rating FROM usage_relationships WHERE rating IS NOT NULL) r
      ON cl.id = r.context_id
    WHERE
      cl.deleted_at IS NULL
      AND (cl.user_id = user_id OR cl.visibility = 'public' OR cl.visibility = 'team')
    GROUP BY
      cl.id, cl.name, cl.description, cl.layer_type, cl.usage_count, ce.embedding
  )
  SELECT
    cs.id AS context_id,
    cs.name,
    cs.description,
    cs.layer_type,
    -- Hybrid recommendation score combining:
    -- 1. Co-occurrence frequency (40%)
    -- 2. Semantic similarity (30% if query provided)
    -- 3. Usage count (20%)
    -- 4. Average rating (10%)
    (
      COALESCE(coc.co_occurrence_count, 0) * 0.4 +
      CASE
        WHEN query_embedding IS NOT NULL AND cs.embedding IS NOT NULL THEN
          (1 - (cs.embedding <=> query_embedding)) * 30
        ELSE 0
      END +
      LEAST(cs.usage_count, 100) * 0.2 +
      cs.avg_rating * 2
    )::DECIMAL AS recommendation_score,
    cs.usage_count,
    cs.avg_rating
  FROM
    context_stats cs
  LEFT JOIN
    co_occurring_contexts coc ON cs.id = coc.context_id
  ORDER BY
    recommendation_score DESC
  LIMIT
    result_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- PART 4: Context Effectiveness Analysis
-- ============================================================================

/**
 * Get effectiveness metrics for contexts
 * Analyzes how well contexts perform in different scenarios
 *
 * @param user_id - User ID for filtering
 * @param min_usage_count - Minimum usage count to include
 *
 * @returns Table of context effectiveness metrics
 */
CREATE OR REPLACE FUNCTION get_context_effectiveness(
  user_id UUID,
  min_usage_count INT DEFAULT 5
)
RETURNS TABLE (
  context_id UUID,
  context_name VARCHAR,
  layer_type VARCHAR,
  total_uses BIGINT,
  avg_rating DECIMAL,
  unique_templates BIGINT,
  unique_users BIGINT,
  effectiveness_score DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cl.id AS context_id,
    cl.name AS context_name,
    cl.layer_type,
    COUNT(ur.id) AS total_uses,
    COALESCE(AVG(ur.rating), 0)::DECIMAL AS avg_rating,
    COUNT(DISTINCT ur.template_id) AS unique_templates,
    COUNT(DISTINCT ur.user_id) AS unique_users,
    -- Effectiveness score: combines usage, ratings, and diversity
    (
      LEAST(COUNT(ur.id), 100) * 0.3 +
      COALESCE(AVG(ur.rating), 0) * 20 +
      COUNT(DISTINCT ur.template_id) * 0.2 +
      COUNT(DISTINCT ur.user_id) * 0.1
    )::DECIMAL AS effectiveness_score
  FROM
    context_layers cl
  LEFT JOIN
    usage_relationships ur ON cl.id = ur.context_id
  WHERE
    cl.deleted_at IS NULL
    AND (cl.user_id = user_id OR cl.visibility IN ('public', 'team'))
  GROUP BY
    cl.id, cl.name, cl.layer_type
  HAVING
    COUNT(ur.id) >= min_usage_count
  ORDER BY
    effectiveness_score DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- PART 5: Find Frequently Paired Contexts
-- ============================================================================

/**
 * Find contexts that are frequently used together
 * Useful for suggesting context combinations
 *
 * @param context_id - The context ID to find associations for
 * @param user_id - User ID for filtering
 * @param result_limit - Maximum number of results
 *
 * @returns Table of associated contexts with association strength
 */
CREATE OR REPLACE FUNCTION get_context_associations(
  context_id UUID,
  user_id UUID DEFAULT NULL,
  result_limit INT DEFAULT 10
)
RETURNS TABLE (
  associated_context_id UUID,
  associated_context_name VARCHAR,
  layer_type VARCHAR,
  co_occurrence_count BIGINT,
  association_strength DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  WITH context_templates AS (
    -- Get all templates that use the given context
    SELECT DISTINCT template_id
    FROM usage_relationships
    WHERE context_id = context_id
  ),
  associated_contexts AS (
    -- Find other contexts used with those templates
    SELECT
      ur.context_id AS assoc_context_id,
      COUNT(*) AS co_count
    FROM
      usage_relationships ur
    WHERE
      ur.template_id IN (SELECT template_id FROM context_templates)
      AND ur.context_id != context_id
      AND (user_id IS NULL OR ur.user_id = user_id)
    GROUP BY
      ur.context_id
  )
  SELECT
    cl.id AS associated_context_id,
    cl.name AS associated_context_name,
    cl.layer_type,
    ac.co_count AS co_occurrence_count,
    -- Normalize by total uses of the original context
    (ac.co_count::DECIMAL / GREATEST((
      SELECT COUNT(*) FROM usage_relationships WHERE context_id = context_id
    ), 1))::DECIMAL AS association_strength
  FROM
    associated_contexts ac
  INNER JOIN
    context_layers cl ON ac.assoc_context_id = cl.id
  WHERE
    cl.deleted_at IS NULL
  ORDER BY
    co_occurrence_count DESC
  LIMIT
    result_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- PART 6: Hybrid Search (Text + Semantic)
-- ============================================================================

/**
 * Hybrid search combining full-text and semantic similarity
 *
 * @param query_text - Text query for full-text search
 * @param query_embedding - Embedding for semantic search
 * @param user_id - User ID for filtering
 * @param result_limit - Maximum number of results
 * @param semantic_weight - Weight for semantic similarity (0.0 to 1.0)
 *
 * @returns Table of contexts with hybrid scores
 */
CREATE OR REPLACE FUNCTION hybrid_search_contexts(
  query_text TEXT,
  query_embedding vector(384),
  user_id UUID DEFAULT NULL,
  result_limit INT DEFAULT 10,
  semantic_weight DECIMAL DEFAULT 0.7
)
RETURNS TABLE (
  context_id UUID,
  name VARCHAR,
  description TEXT,
  content TEXT,
  layer_type VARCHAR,
  hybrid_score DECIMAL,
  text_rank DECIMAL,
  semantic_similarity DECIMAL
) AS $$
DECLARE
  text_weight DECIMAL := 1.0 - semantic_weight;
BEGIN
  RETURN QUERY
  SELECT
    cl.id AS context_id,
    cl.name,
    cl.description,
    cl.content,
    cl.layer_type,
    -- Hybrid score: weighted combination of text and semantic
    (
      COALESCE(ts_rank(
        to_tsvector('english', cl.name || ' ' || cl.description || ' ' || cl.content),
        plainto_tsquery('english', query_text)
      ), 0) * text_weight +
      COALESCE((1 - (ce.embedding <=> query_embedding)), 0) * semantic_weight
    )::DECIMAL AS hybrid_score,
    ts_rank(
      to_tsvector('english', cl.name || ' ' || cl.description || ' ' || cl.content),
      plainto_tsquery('english', query_text)
    )::DECIMAL AS text_rank,
    (1 - (ce.embedding <=> query_embedding))::DECIMAL AS semantic_similarity
  FROM
    context_layers cl
  LEFT JOIN
    context_embeddings ce ON cl.id = ce.context_id
  WHERE
    cl.deleted_at IS NULL
    AND (
      user_id IS NULL
      OR cl.user_id = user_id
      OR cl.visibility = 'public'
      OR (cl.team_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM team_members tm
        WHERE tm.team_id = cl.team_id AND tm.user_id = user_id
      ))
    )
  ORDER BY
    hybrid_score DESC
  LIMIT
    result_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

-- Test that functions were created successfully
DO $$
DECLARE
  function_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO function_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
  AND p.proname IN (
    'find_similar_contexts',
    'find_similar_templates',
    'get_learned_recommendations',
    'get_context_effectiveness',
    'get_context_associations',
    'hybrid_search_contexts'
  );

  IF function_count < 6 THEN
    RAISE EXCEPTION 'Not all vector functions were created! Found: %', function_count;
  END IF;

  RAISE NOTICE 'Migration completed successfully! Created % functions.', function_count;
END
$$;

-- Show created functions
SELECT
  p.proname AS function_name,
  pg_get_function_arguments(p.oid) AS arguments
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
AND p.proname IN (
  'find_similar_contexts',
  'find_similar_templates',
  'get_learned_recommendations',
  'get_context_effectiveness',
  'get_context_associations',
  'hybrid_search_contexts'
)
ORDER BY p.proname;
