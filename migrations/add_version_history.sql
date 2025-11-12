-- Add version history tracking for templates and contexts
-- Migration: Add comprehensive version control

-- Templates version history table
CREATE TABLE IF NOT EXISTS template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  variables JSONB DEFAULT '[]',
  category VARCHAR(100),
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  change_summary TEXT,
  is_current BOOLEAN DEFAULT false,

  -- Ensure version numbers are unique per template
  UNIQUE(template_id, version_number)
);

-- Context layers version history table
CREATE TABLE IF NOT EXISTS context_layer_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id UUID NOT NULL REFERENCES context_layers(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  layer_type VARCHAR(50) NOT NULL,
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  change_summary TEXT,
  is_current BOOLEAN DEFAULT false,

  UNIQUE(layer_id, version_number)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_template_versions_template_id ON template_versions(template_id);
CREATE INDEX IF NOT EXISTS idx_template_versions_created_at ON template_versions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_template_versions_is_current ON template_versions(is_current) WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_layer_versions_layer_id ON context_layer_versions(layer_id);
CREATE INDEX IF NOT EXISTS idx_layer_versions_created_at ON context_layer_versions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_layer_versions_is_current ON context_layer_versions(is_current) WHERE is_current = true;

-- Function to create a new template version
CREATE OR REPLACE FUNCTION create_template_version(
  p_template_id UUID,
  p_user_id UUID,
  p_change_summary TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_version_number INTEGER;
  v_version_id UUID;
  v_template RECORD;
BEGIN
  -- Get current template data
  SELECT * INTO v_template
  FROM templates
  WHERE id = p_template_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found';
  END IF;

  -- Get next version number
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO v_version_number
  FROM template_versions
  WHERE template_id = p_template_id;

  -- Mark all previous versions as not current
  UPDATE template_versions
  SET is_current = false
  WHERE template_id = p_template_id;

  -- Create new version
  INSERT INTO template_versions (
    template_id,
    version_number,
    name,
    description,
    content,
    variables,
    category,
    tags,
    metadata,
    created_by,
    change_summary,
    is_current
  ) VALUES (
    p_template_id,
    v_version_number,
    v_template.name,
    v_template.description,
    v_template.content,
    v_template.variables,
    v_template.category,
    v_template.tags,
    COALESCE(v_template.metadata, '{}'::jsonb),
    p_user_id,
    p_change_summary,
    true
  ) RETURNING id INTO v_version_id;

  RETURN v_version_id;
END;
$$ LANGUAGE plpgsql;

-- Function to create a new context layer version
CREATE OR REPLACE FUNCTION create_layer_version(
  p_layer_id UUID,
  p_user_id UUID,
  p_change_summary TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_version_number INTEGER;
  v_version_id UUID;
  v_layer RECORD;
BEGIN
  -- Get current layer data
  SELECT * INTO v_layer
  FROM context_layers
  WHERE id = p_layer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Context layer not found';
  END IF;

  -- Get next version number
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO v_version_number
  FROM context_layer_versions
  WHERE layer_id = p_layer_id;

  -- Mark all previous versions as not current
  UPDATE context_layer_versions
  SET is_current = false
  WHERE layer_id = p_layer_id;

  -- Create new version
  INSERT INTO context_layer_versions (
    layer_id,
    version_number,
    name,
    description,
    content,
    layer_type,
    tags,
    metadata,
    created_by,
    change_summary,
    is_current
  ) VALUES (
    p_layer_id,
    v_version_number,
    v_layer.name,
    v_layer.description,
    v_layer.content,
    v_layer.layer_type,
    v_layer.tags,
    COALESCE(v_layer.metadata, '{}'::jsonb),
    p_user_id,
    p_change_summary,
    true
  ) RETURNING id INTO v_version_id;

  RETURN v_version_id;
END;
$$ LANGUAGE plpgsql;

-- Function to revert template to a specific version
CREATE OR REPLACE FUNCTION revert_template_to_version(
  p_template_id UUID,
  p_version_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_version RECORD;
BEGIN
  -- Get version data
  SELECT * INTO v_version
  FROM template_versions
  WHERE id = p_version_id AND template_id = p_template_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Version not found';
  END IF;

  -- Update template with version data
  UPDATE templates
  SET
    name = v_version.name,
    description = v_version.description,
    content = v_version.content,
    variables = v_version.variables,
    category = v_version.category,
    tags = v_version.tags,
    metadata = v_version.metadata,
    updated_at = NOW()
  WHERE id = p_template_id;

  -- Create a new version marking the revert
  PERFORM create_template_version(
    p_template_id,
    p_user_id,
    format('Reverted to version %s', v_version.version_number)
  );

  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Function to revert context layer to a specific version
CREATE OR REPLACE FUNCTION revert_layer_to_version(
  p_layer_id UUID,
  p_version_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_version RECORD;
BEGIN
  -- Get version data
  SELECT * INTO v_version
  FROM context_layer_versions
  WHERE id = p_version_id AND layer_id = p_layer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Version not found';
  END IF;

  -- Update layer with version data
  UPDATE context_layers
  SET
    name = v_version.name,
    description = v_version.description,
    content = v_version.content,
    layer_type = v_version.layer_type,
    tags = v_version.tags,
    metadata = v_version.metadata,
    updated_at = NOW()
  WHERE id = p_layer_id;

  -- Create a new version marking the revert
  PERFORM create_layer_version(
    p_layer_id,
    p_user_id,
    format('Reverted to version %s', v_version.version_number)
  );

  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-create versions on template update
CREATE OR REPLACE FUNCTION auto_create_template_version()
RETURNS TRIGGER AS $$
BEGIN
  -- Only create version if content actually changed
  IF (OLD.content IS DISTINCT FROM NEW.content) OR
     (OLD.name IS DISTINCT FROM NEW.name) OR
     (OLD.description IS DISTINCT FROM NEW.description) THEN

    PERFORM create_template_version(
      NEW.id,
      NEW.user_id,
      'Auto-saved version'
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-create versions on layer update
CREATE OR REPLACE FUNCTION auto_create_layer_version()
RETURNS TRIGGER AS $$
BEGIN
  -- Only create version if content actually changed
  IF (OLD.content IS DISTINCT FROM NEW.content) OR
     (OLD.name IS DISTINCT FROM NEW.name) OR
     (OLD.description IS DISTINCT FROM NEW.description) THEN

    PERFORM create_layer_version(
      NEW.id,
      NEW.user_id,
      'Auto-saved version'
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers (drop first if they exist)
DROP TRIGGER IF EXISTS template_version_trigger ON templates;
CREATE TRIGGER template_version_trigger
  AFTER UPDATE ON templates
  FOR EACH ROW
  EXECUTE FUNCTION auto_create_template_version();

DROP TRIGGER IF EXISTS layer_version_trigger ON context_layers;
CREATE TRIGGER layer_version_trigger
  AFTER UPDATE ON context_layers
  FOR EACH ROW
  EXECUTE FUNCTION auto_create_layer_version();

-- Function to get version history for a template
CREATE OR REPLACE FUNCTION get_template_version_history(
  p_template_id UUID,
  p_limit INTEGER DEFAULT 50
) RETURNS TABLE (
  id UUID,
  version_number INTEGER,
  name VARCHAR(255),
  description TEXT,
  content TEXT,
  created_at TIMESTAMP,
  created_by UUID,
  creator_username VARCHAR(255),
  change_summary TEXT,
  is_current BOOLEAN,
  content_length INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    tv.id,
    tv.version_number,
    tv.name,
    tv.description,
    tv.content,
    tv.created_at,
    tv.created_by,
    u.username as creator_username,
    tv.change_summary,
    tv.is_current,
    LENGTH(tv.content) as content_length
  FROM template_versions tv
  LEFT JOIN users u ON tv.created_by = u.id
  WHERE tv.template_id = p_template_id
  ORDER BY tv.version_number DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to get version history for a context layer
CREATE OR REPLACE FUNCTION get_layer_version_history(
  p_layer_id UUID,
  p_limit INTEGER DEFAULT 50
) RETURNS TABLE (
  id UUID,
  version_number INTEGER,
  name VARCHAR(255),
  description TEXT,
  content TEXT,
  created_at TIMESTAMP,
  created_by UUID,
  creator_username VARCHAR(255),
  change_summary TEXT,
  is_current BOOLEAN,
  content_length INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    lv.id,
    lv.version_number,
    lv.name,
    lv.description,
    lv.content,
    lv.created_at,
    lv.created_by,
    u.username as creator_username,
    lv.change_summary,
    lv.is_current,
    LENGTH(lv.content) as content_length
  FROM context_layer_versions lv
  LEFT JOIN users u ON lv.created_by = u.id
  WHERE lv.layer_id = p_layer_id
  ORDER BY lv.version_number DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
