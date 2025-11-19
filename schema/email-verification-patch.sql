-- Patch: Add email_verification_pins table for email verification
-- This table is required by the authentication handlers

-- Create email_verification_pins table
CREATE TABLE IF NOT EXISTS email_verification_pins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  pin VARCHAR(6) NOT NULL,
  email VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_pins(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_email ON email_verification_pins(email);
CREATE INDEX IF NOT EXISTS idx_email_verification_expires ON email_verification_pins(expires_at);

-- Add comment
COMMENT ON TABLE email_verification_pins IS 'Stores email verification PINs for new user registration';
COMMENT ON COLUMN email_verification_pins.pin IS '6-digit verification PIN sent to user email';
COMMENT ON COLUMN email_verification_pins.attempts IS 'Number of verification attempts (rate limiting)';
