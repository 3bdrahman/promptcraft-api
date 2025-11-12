-- Add team sharing to templates and context_layers
-- Migration: Add team_id field for team collaboration

-- Add team_id to templates table
ALTER TABLE templates
ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE CASCADE;

-- Add team_id to context_layers table
ALTER TABLE context_layers
ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE CASCADE;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_templates_team_id ON templates(team_id);
CREATE INDEX IF NOT EXISTS idx_context_layers_team_id ON context_layers(team_id);

-- Add visibility column to templates (if not exists) for fine-grained control
-- Values: 'private', 'team', 'public'
-- Note: is_public will remain for backward compatibility (public = true means visibility = 'public')
ALTER TABLE templates
ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) DEFAULT 'private';

-- Update existing templates to have correct visibility based on is_public
UPDATE templates
SET visibility = CASE
  WHEN is_public = true THEN 'public'
  ELSE 'private'
END
WHERE visibility = 'private';

-- Add visibility column to context_layers (if it doesn't already exist)
-- The column might exist from previous schema, so we check first
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'context_layers' AND column_name = 'visibility'
  ) THEN
    ALTER TABLE context_layers ADD COLUMN visibility VARCHAR(20) DEFAULT 'private';
  END IF;
END $$;

-- Helper function to check if user has access to a template
CREATE OR REPLACE FUNCTION user_has_template_access(
  p_user_id UUID,
  p_template_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_team_id UUID;
  v_is_public BOOLEAN;
  v_owner_id UUID;
  v_visibility VARCHAR(20);
BEGIN
  -- Get template info
  SELECT team_id, is_public, user_id, visibility
  INTO v_team_id, v_is_public, v_owner_id, v_visibility
  FROM templates
  WHERE id = p_template_id AND deleted_at IS NULL;

  -- Template doesn't exist
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Owner always has access
  IF v_owner_id = p_user_id THEN
    RETURN TRUE;
  END IF;

  -- Public templates are accessible to everyone
  IF v_is_public = TRUE OR v_visibility = 'public' THEN
    RETURN TRUE;
  END IF;

  -- Team templates require team membership
  IF v_team_id IS NOT NULL AND v_visibility = 'team' THEN
    RETURN user_has_team_access(p_user_id, v_team_id);
  END IF;

  -- Private templates only accessible to owner
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- Helper function to check if user has access to a context layer
CREATE OR REPLACE FUNCTION user_has_layer_access(
  p_user_id UUID,
  p_layer_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_team_id UUID;
  v_owner_id UUID;
  v_visibility VARCHAR(20);
BEGIN
  -- Get layer info
  SELECT team_id, user_id, visibility
  INTO v_team_id, v_owner_id, v_visibility
  FROM context_layers
  WHERE id = p_layer_id AND deleted_at IS NULL;

  -- Layer doesn't exist
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Owner always has access
  IF v_owner_id = p_user_id THEN
    RETURN TRUE;
  END IF;

  -- Public layers are accessible to everyone
  IF v_visibility = 'public' THEN
    RETURN TRUE;
  END IF;

  -- Team layers require team membership
  IF v_team_id IS NOT NULL AND v_visibility = 'team' THEN
    RETURN user_has_team_access(p_user_id, v_team_id);
  END IF;

  -- Private layers only accessible to owner
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- Function to share template with team
CREATE OR REPLACE FUNCTION share_template_with_team(
  p_template_id UUID,
  p_team_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_owner_id UUID;
BEGIN
  -- Check if user owns the template
  SELECT user_id INTO v_owner_id
  FROM templates
  WHERE id = p_template_id;

  IF v_owner_id != p_user_id THEN
    RAISE EXCEPTION 'Only template owner can share with teams';
  END IF;

  -- Check if user has access to the team
  IF NOT user_has_team_access(p_user_id, p_team_id) THEN
    RAISE EXCEPTION 'User does not have access to this team';
  END IF;

  -- Share the template
  UPDATE templates
  SET team_id = p_team_id,
      visibility = 'team',
      updated_at = NOW()
  WHERE id = p_template_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Function to share context layer with team
CREATE OR REPLACE FUNCTION share_layer_with_team(
  p_layer_id UUID,
  p_team_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_owner_id UUID;
BEGIN
  -- Check if user owns the layer
  SELECT user_id INTO v_owner_id
  FROM context_layers
  WHERE id = p_layer_id;

  IF v_owner_id != p_user_id THEN
    RAISE EXCEPTION 'Only layer owner can share with teams';
  END IF;

  -- Check if user has access to the team
  IF NOT user_has_team_access(p_user_id, p_team_id) THEN
    RAISE EXCEPTION 'User does not have access to this team';
  END IF;

  -- Share the layer
  UPDATE context_layers
  SET team_id = p_team_id,
      visibility = 'team',
      updated_at = NOW()
  WHERE id = p_layer_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Function to unshare (make private)
CREATE OR REPLACE FUNCTION unshare_template(
  p_template_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_owner_id UUID;
BEGIN
  -- Check if user owns the template
  SELECT user_id INTO v_owner_id
  FROM templates
  WHERE id = p_template_id;

  IF v_owner_id != p_user_id THEN
    RAISE EXCEPTION 'Only template owner can unshare';
  END IF;

  -- Unshare the template
  UPDATE templates
  SET team_id = NULL,
      visibility = 'private',
      is_public = FALSE,
      updated_at = NOW()
  WHERE id = p_template_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION unshare_layer(
  p_layer_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_owner_id UUID;
BEGIN
  -- Check if user owns the layer
  SELECT user_id INTO v_owner_id
  FROM context_layers
  WHERE id = p_layer_id;

  IF v_owner_id != p_user_id THEN
    RAISE EXCEPTION 'Only layer owner can unshare';
  END IF;

  -- Unshare the layer
  UPDATE context_layers
  SET team_id = NULL,
      visibility = 'private',
      updated_at = NOW()
  WHERE id = p_layer_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
