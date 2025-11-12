-- Dependency Tracking System
-- Track relationships between templates, contexts, and other resources
-- Enables impact analysis and intelligent suggestions

-- Template dependencies table (tracks what a template depends on)
CREATE TABLE IF NOT EXISTS template_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  dependency_type VARCHAR(50) NOT NULL, -- 'context_layer', 'template', 'variable'
  dependency_id UUID, -- ID of the dependent resource (nullable for variables)
  dependency_name VARCHAR(255), -- Name/reference for display
  usage_count INTEGER DEFAULT 0, -- How many times it's referenced
  is_required BOOLEAN DEFAULT false, -- Whether this dependency is required
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  -- Prevent duplicate dependencies
  UNIQUE(template_id, dependency_type, dependency_id, dependency_name)
);

-- Context layer dependencies table (tracks what a context layer depends on)
CREATE TABLE IF NOT EXISTS layer_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id UUID NOT NULL REFERENCES context_layers(id) ON DELETE CASCADE,
  dependency_type VARCHAR(50) NOT NULL, -- 'layer', 'template', 'external_resource'
  dependency_id UUID, -- ID of the dependent resource
  dependency_name VARCHAR(255), -- Name/reference for display
  usage_count INTEGER DEFAULT 0,
  is_required BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(layer_id, dependency_type, dependency_id, dependency_name)
);

-- Usage tracking (tracks when templates/contexts are used together)
CREATE TABLE IF NOT EXISTS usage_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID REFERENCES templates(id) ON DELETE CASCADE,
  layer_id UUID REFERENCES context_layers(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  used_at TIMESTAMP DEFAULT NOW(),
  execution_count INTEGER DEFAULT 1,

  -- Track unique combinations
  UNIQUE(template_id, layer_id, user_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_template_dependencies_template_id ON template_dependencies(template_id);
CREATE INDEX IF NOT EXISTS idx_template_dependencies_type ON template_dependencies(dependency_type);
CREATE INDEX IF NOT EXISTS idx_template_dependencies_dep_id ON template_dependencies(dependency_id);

CREATE INDEX IF NOT EXISTS idx_layer_dependencies_layer_id ON layer_dependencies(layer_id);
CREATE INDEX IF NOT EXISTS idx_layer_dependencies_type ON layer_dependencies(dependency_type);
CREATE INDEX IF NOT EXISTS idx_layer_dependencies_dep_id ON layer_dependencies(dependency_id);

CREATE INDEX IF NOT EXISTS idx_usage_relationships_template ON usage_relationships(template_id);
CREATE INDEX IF NOT EXISTS idx_usage_relationships_layer ON usage_relationships(layer_id);
CREATE INDEX IF NOT EXISTS idx_usage_relationships_user ON usage_relationships(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_relationships_used_at ON usage_relationships(used_at DESC);

-- Function to extract variable references from template content
CREATE OR REPLACE FUNCTION extract_template_variables(content TEXT)
RETURNS TEXT[] AS $$
DECLARE
  variables TEXT[];
BEGIN
  -- Extract {{variable}} patterns
  SELECT ARRAY_AGG(DISTINCT matches[1])
  INTO variables
  FROM regexp_matches(content, '\{\{([a-zA-Z0-9_]+)\}\}', 'g') AS matches;

  RETURN COALESCE(variables, '{}');
END;
$$ LANGUAGE plpgsql;

-- Function to analyze and update template dependencies
CREATE OR REPLACE FUNCTION analyze_template_dependencies(p_template_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_template RECORD;
  v_variables TEXT[];
  v_var TEXT;
BEGIN
  -- Get template content
  SELECT * INTO v_template FROM templates WHERE id = p_template_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found';
  END IF;

  -- Clear existing dependencies for this template
  DELETE FROM template_dependencies WHERE template_id = p_template_id;

  -- Extract and insert variable dependencies
  v_variables := extract_template_variables(v_template.content);

  FOREACH v_var IN ARRAY v_variables
  LOOP
    INSERT INTO template_dependencies (
      template_id, dependency_type, dependency_name, is_required
    ) VALUES (
      p_template_id, 'variable', v_var, true
    )
    ON CONFLICT (template_id, dependency_type, dependency_id, dependency_name)
    DO UPDATE SET updated_at = NOW();
  END LOOP;

  -- TODO: Could add analysis for template references, context layer hints, etc.

  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Function to get template dependencies with details
CREATE OR REPLACE FUNCTION get_template_dependencies(p_template_id UUID)
RETURNS TABLE (
  dependency_id UUID,
  dependency_type VARCHAR(50),
  dependency_name VARCHAR(255),
  usage_count INTEGER,
  is_required BOOLEAN,
  resource_exists BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    td.dependency_id,
    td.dependency_type,
    td.dependency_name,
    td.usage_count,
    td.is_required,
    CASE
      WHEN td.dependency_type = 'context_layer' THEN
        EXISTS(SELECT 1 FROM context_layers WHERE id = td.dependency_id)
      WHEN td.dependency_type = 'template' THEN
        EXISTS(SELECT 1 FROM templates WHERE id = td.dependency_id)
      ELSE true -- Variables don't have IDs
    END as resource_exists
  FROM template_dependencies td
  WHERE td.template_id = p_template_id
  ORDER BY td.is_required DESC, td.dependency_type, td.dependency_name;
END;
$$ LANGUAGE plpgsql;

-- Function to find what depends on a given resource
CREATE OR REPLACE FUNCTION get_resource_dependents(
  p_resource_type VARCHAR(50), -- 'template' or 'context_layer'
  p_resource_id UUID
) RETURNS TABLE (
  dependent_id UUID,
  dependent_type VARCHAR(50),
  dependent_name VARCHAR(255),
  dependency_count INTEGER
) AS $$
BEGIN
  IF p_resource_type = 'template' THEN
    RETURN QUERY
    SELECT
      td.template_id as dependent_id,
      'template'::VARCHAR(50) as dependent_type,
      t.name as dependent_name,
      COUNT(*)::INTEGER as dependency_count
    FROM template_dependencies td
    JOIN templates t ON td.template_id = t.id
    WHERE td.dependency_id = p_resource_id
      AND td.dependency_type = 'template'
      AND t.deleted_at IS NULL
    GROUP BY td.template_id, t.name;

  ELSIF p_resource_type = 'context_layer' THEN
    RETURN QUERY
    SELECT
      td.template_id as dependent_id,
      'template'::VARCHAR(50) as dependent_type,
      t.name as dependent_name,
      COUNT(*)::INTEGER as dependency_count
    FROM template_dependencies td
    JOIN templates t ON td.template_id = t.id
    WHERE td.dependency_id = p_resource_id
      AND td.dependency_type = 'context_layer'
      AND t.deleted_at IS NULL
    GROUP BY td.template_id, t.name

    UNION ALL

    SELECT
      ld.layer_id as dependent_id,
      'context_layer'::VARCHAR(50) as dependent_type,
      cl.name as dependent_name,
      COUNT(*)::INTEGER as dependency_count
    FROM layer_dependencies ld
    JOIN context_layers cl ON ld.layer_id = cl.id
    WHERE ld.dependency_id = p_resource_id
      AND ld.dependency_type = 'layer'
      AND cl.deleted_at IS NULL
    GROUP BY ld.layer_id, cl.name;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to track template+context usage
CREATE OR REPLACE FUNCTION track_usage_relationship(
  p_template_id UUID,
  p_layer_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  INSERT INTO usage_relationships (template_id, layer_id, user_id, execution_count)
  VALUES (p_template_id, p_layer_id, p_user_id, 1)
  ON CONFLICT (template_id, layer_id, user_id)
  DO UPDATE SET
    execution_count = usage_relationships.execution_count + 1,
    used_at = NOW();

  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Function to get suggested contexts for a template (based on usage patterns)
CREATE OR REPLACE FUNCTION get_suggested_contexts(
  p_template_id UUID,
  p_user_id UUID,
  p_limit INTEGER DEFAULT 5
) RETURNS TABLE (
  layer_id UUID,
  layer_name VARCHAR(255),
  layer_type VARCHAR(50),
  usage_count INTEGER,
  last_used TIMESTAMP
) AS $$
BEGIN
  -- First, get contexts this user has used with this template
  RETURN QUERY
  SELECT
    cl.id as layer_id,
    cl.name as layer_name,
    cl.layer_type,
    ur.execution_count::INTEGER as usage_count,
    ur.used_at as last_used
  FROM usage_relationships ur
  JOIN context_layers cl ON ur.layer_id = cl.id
  WHERE ur.template_id = p_template_id
    AND ur.user_id = p_user_id
    AND cl.deleted_at IS NULL
  ORDER BY ur.execution_count DESC, ur.used_at DESC
  LIMIT p_limit;

  -- TODO: Could add global popular combinations, similar template patterns, etc.
END;
$$ LANGUAGE plpgsql;

-- Function to get dependency graph (for visualization)
CREATE OR REPLACE FUNCTION get_dependency_graph(
  p_resource_type VARCHAR(50),
  p_resource_id UUID,
  p_depth INTEGER DEFAULT 1
) RETURNS TABLE (
  node_id UUID,
  node_type VARCHAR(50),
  node_name VARCHAR(255),
  relationship_type VARCHAR(50), -- 'depends_on' or 'used_by'
  depth_level INTEGER
) AS $$
BEGIN
  -- For now, return immediate dependencies (depth 1)
  -- Future: Implement recursive graph traversal

  IF p_resource_type = 'template' THEN
    -- What this template depends on
    RETURN QUERY
    SELECT
      td.dependency_id as node_id,
      td.dependency_type as node_type,
      COALESCE(
        (SELECT name FROM templates WHERE id = td.dependency_id),
        (SELECT name FROM context_layers WHERE id = td.dependency_id),
        td.dependency_name
      ) as node_name,
      'depends_on'::VARCHAR(50) as relationship_type,
      1 as depth_level
    FROM template_dependencies td
    WHERE td.template_id = p_resource_id
      AND td.dependency_id IS NOT NULL;

  ELSIF p_resource_type = 'context_layer' THEN
    -- What depends on this layer
    RETURN QUERY
    SELECT
      t.id as node_id,
      'template'::VARCHAR(50) as node_type,
      t.name as node_name,
      'used_by'::VARCHAR(50) as relationship_type,
      1 as depth_level
    FROM template_dependencies td
    JOIN templates t ON td.template_id = t.id
    WHERE td.dependency_id = p_resource_id
      AND td.dependency_type = 'context_layer'
      AND t.deleted_at IS NULL;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-analyze template dependencies on save
CREATE OR REPLACE FUNCTION trigger_analyze_template_dependencies()
RETURNS TRIGGER AS $$
BEGIN
  -- Analyze dependencies when content changes
  IF (TG_OP = 'INSERT') OR (OLD.content IS DISTINCT FROM NEW.content) THEN
    PERFORM analyze_template_dependencies(NEW.id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS template_dependency_analysis_trigger ON templates;
CREATE TRIGGER template_dependency_analysis_trigger
  AFTER INSERT OR UPDATE ON templates
  FOR EACH ROW
  EXECUTE FUNCTION trigger_analyze_template_dependencies();
