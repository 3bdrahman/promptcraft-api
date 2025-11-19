-- Patch: Add device_info column to session table
-- This column stores information about the device used for login

-- Add device_info column to session table
ALTER TABLE session
  ADD COLUMN IF NOT EXISTS device_info TEXT;

-- Add comment
COMMENT ON COLUMN session.device_info IS 'Information about the device used for this session (e.g., browser, OS)';
