# JWT Token Configuration

## Current Settings (Updated)

- **Access Token Expiry**: 7 days (default)
- **Refresh Token Expiry**: 30 days (default)

## Why the Change?

The previous 30-minute access token expiry was causing users to be logged out frequently. The new 7-day expiry provides a better user experience while still being secure.

## Security Considerations

**7-day access tokens are secure because:**
- Tokens are stored in memory/localStorage (not cookies with long expiry)
- HTTPS encrypts token transmission
- Tokens are revoked on logout
- Session table tracks all active sessions
- Refresh tokens last 30 days and can be revoked

## Environment Variables

You can override these defaults in your `.env` or Vercel environment variables:

```bash
# Access token expiry (default: 7d)
# Examples: '1h', '24h', '7d', '30d'
ACCESS_TOKEN_EXPIRY=7d

# Refresh token expiry (default: 30d)
# Examples: '7d', '30d', '90d'
REFRESH_TOKEN_EXPIRY=30d
```

## Recommended Settings by Use Case

### Development
```bash
ACCESS_TOKEN_EXPIRY=30d  # Never logout during dev
REFRESH_TOKEN_EXPIRY=90d
```

### Production (Balanced - Current)
```bash
ACCESS_TOKEN_EXPIRY=7d   # Weekly re-authentication
REFRESH_TOKEN_EXPIRY=30d
```

### High Security
```bash
ACCESS_TOKEN_EXPIRY=1h   # Hourly refresh needed
REFRESH_TOKEN_EXPIRY=7d  # Weekly re-login
```

### Mobile Apps
```bash
ACCESS_TOKEN_EXPIRY=30d  # Long-lived sessions
REFRESH_TOKEN_EXPIRY=90d # Quarterly re-login
```

## Token Refresh Flow

Even with longer access tokens, the refresh mechanism still works:

1. **Access token expires** after 7 days (or whatever you set)
2. **Frontend detects 401** error
3. **Frontend calls** `/api/auth/refresh` with refresh_token
4. **Backend validates** refresh token (checks DB + JWT signature)
5. **Backend issues** new access token
6. **User stays logged in** seamlessly

## Manual Token Revocation

If you need to revoke tokens manually:

```sql
-- Revoke all sessions for a user
UPDATE session SET revoked_at = NOW() WHERE user_id = 'USER_ID';

-- Revoke specific session
UPDATE session SET revoked_at = NOW() WHERE id = 'SESSION_ID';
```

## Checking Active Sessions

```sql
-- See all active sessions
SELECT u.email, s.created_at, s.expires_at, s.ip_address, s.user_agent
FROM session s
JOIN "user" u ON s.user_id = u.id
WHERE s.revoked_at IS NULL
  AND s.expires_at > NOW();
```
