-- Patch: Add missing authentication columns to user table
-- This adds password-based authentication support to the enterprise schema

-- Add authentication columns to user table
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS username VARCHAR(255),
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_token VARCHAR(255);

-- Add unique constraint on username (within tenant)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_tenant_username_key'
  ) THEN
    ALTER TABLE "user"
      ADD CONSTRAINT user_tenant_username_key UNIQUE(tenant_id, username);
  END IF;
END $$;

-- Create index on username for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_username ON "user"(username);
CREATE INDEX IF NOT EXISTS idx_user_email_verified ON "user"(email_verified);
CREATE INDEX IF NOT EXISTS idx_user_locked_until ON "user"(locked_until);

-- Add comment
COMMENT ON COLUMN "user".password_hash IS 'Bcrypt hash of user password (null for OAuth-only users)';
COMMENT ON COLUMN "user".email_verified IS 'Whether user has verified their email address';
COMMENT ON COLUMN "user".failed_login_attempts IS 'Count of consecutive failed login attempts';
COMMENT ON COLUMN "user".locked_until IS 'Timestamp until which account is locked due to failed attempts';
COMMENT ON COLUMN "user".verification_token IS 'Token for email verification (deprecated - use email_verification_pins)';
