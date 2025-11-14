-- Migration: Add User Settings Support
-- Description: Adds settings JSONB column to users table for storing user preferences
-- Date: 2025-01-14
-- Author: PromptCraft Team

-- ============================================
-- 1. Add settings column to users table
-- ============================================

-- Add settings column (JSONB for flexible schema)
ALTER TABLE users
ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb;

-- Add index for settings queries (GIN index for JSONB)
CREATE INDEX IF NOT EXISTS idx_users_settings
ON users USING GIN (settings);

-- Add comments
COMMENT ON COLUMN users.settings IS 'User application settings stored as JSONB (theme, ai config, templates, notifications, etc.)';

-- ============================================
-- 2. Migration for existing user_preferences to settings
-- ============================================

-- This is optional - for backward compatibility
-- Convert existing user_preferences to settings JSONB format
DO $$
DECLARE
  user_record RECORD;
  settings_obj JSONB;
BEGIN
  -- Check if user_preferences table exists
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_preferences') THEN

    -- For each user with preferences
    FOR user_record IN
      SELECT DISTINCT user_id FROM user_preferences
    LOOP
      -- Build settings object from preferences
      SELECT jsonb_object_agg(
        category || '_' || key,
        value
      ) INTO settings_obj
      FROM user_preferences
      WHERE user_id = user_record.user_id;

      -- Update user's settings column
      UPDATE users
      SET settings = settings_obj
      WHERE id = user_record.user_id;

    END LOOP;

    RAISE NOTICE 'Migrated user_preferences to settings for all users';
  ELSE
    RAISE NOTICE 'user_preferences table does not exist, skipping migration';
  END IF;
END $$;

-- ============================================
-- 3. Helper functions for settings management
-- ============================================

-- Function to get a specific setting value
CREATE OR REPLACE FUNCTION get_user_setting(
  p_user_id UUID,
  p_key TEXT,
  p_default_value JSONB DEFAULT 'null'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_value JSONB;
BEGIN
  SELECT settings->p_key INTO v_value
  FROM users
  WHERE id = p_user_id;

  RETURN COALESCE(v_value, p_default_value);
END;
$$;

COMMENT ON FUNCTION get_user_setting IS 'Get a specific setting value for a user with optional default';

-- Function to set a specific setting value
CREATE OR REPLACE FUNCTION set_user_setting(
  p_user_id UUID,
  p_key TEXT,
  p_value JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE users
  SET settings = jsonb_set(
    COALESCE(settings, '{}'::jsonb),
    ARRAY[p_key],
    p_value,
    true
  ),
  updated_at = NOW()
  WHERE id = p_user_id;

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION set_user_setting IS 'Set a specific setting value for a user';

-- Function to merge settings
CREATE OR REPLACE FUNCTION merge_user_settings(
  p_user_id UUID,
  p_settings JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_merged_settings JSONB;
BEGIN
  UPDATE users
  SET settings = COALESCE(settings, '{}'::jsonb) || p_settings,
      updated_at = NOW()
  WHERE id = p_user_id
  RETURNING settings INTO v_merged_settings;

  RETURN v_merged_settings;
END;
$$;

COMMENT ON FUNCTION merge_user_settings IS 'Merge new settings with existing user settings';

-- ============================================
-- 4. Example default settings structure
-- ============================================

-- This is just documentation for the expected settings schema
COMMENT ON COLUMN users.settings IS 'Expected settings structure:
{
  "theme": "system" | "light" | "dark",
  "ai": {
    "defaultProvider": "openai" | "anthropic" | "google",
    "defaultModel": "gpt-4o" | "claude-3-opus" | "gemini-pro",
    "temperature": 0.7,
    "maxTokens": 4000
  },
  "templates": {
    "defaultCategory": "general",
    "defaultVisibility": "public" | "private"
  },
  "notifications": {
    "email": true,
    "templateLikes": true,
    "templateClones": true,
    "teamInvites": true,
    "weeklyDigest": false
  },
  "general": {
    "autoIncludeProfile": true
  }
}';

-- ============================================
-- 5. Verification
-- ============================================

-- Verify column exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users'
    AND column_name = 'settings'
  ) THEN
    RAISE NOTICE '✓ settings column added successfully to users table';
  ELSE
    RAISE EXCEPTION '✗ Failed to add settings column to users table';
  END IF;
END $$;

-- ============================================
-- 6. Rollback script (commented out)
-- ============================================

/*
-- To rollback this migration:

DROP FUNCTION IF EXISTS get_user_setting(UUID, TEXT, JSONB);
DROP FUNCTION IF NOT EXISTS set_user_setting(UUID, TEXT, JSONB);
DROP FUNCTION IF EXISTS merge_user_settings(UUID, JSONB);

DROP INDEX IF EXISTS idx_users_settings;

ALTER TABLE users DROP COLUMN IF EXISTS settings;
*/

-- ============================================
-- Migration complete
-- ============================================

SELECT 'Migration completed: add_user_settings.sql' AS status;
