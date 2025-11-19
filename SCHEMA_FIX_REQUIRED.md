# CRITICAL: Schema Fix Required

## Issue
The enterprise schema is missing password authentication columns in the `user` table.

## Required Fix
Before the API can work, you need to apply the authentication columns patch:

```bash
# Connect to your database
psql $DATABASE_URL

# Apply the patch
\i schema/auth-columns-patch.sql
```

## What This Adds
The patch adds these columns to the `user` table:
- `username` - User's display name/login name
- `password_hash` - Bcrypt password hash
- `email_verified` - Email verification status
- `failed_login_attempts` - Login attempt counter
- `locked_until` - Account lockout timestamp
- `last_login_at` - Last successful login
- `verification_token` - Email verification token

## Alternative: Full Schema Recreation
If you haven't deployed yet, you can update the enterprise-schema.sql to include these columns from the start.

## Why This Happened
The original enterprise schema was designed for OAuth-based authentication. The password authentication fields need to be added to support the existing auth handlers.
