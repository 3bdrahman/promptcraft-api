# 🔧 Quick Fix: Schema Update Required

## What Happened?
You're seeing the error: **"column username does not exist"** because the database is missing password authentication columns.

## ✅ Quick Fix (Choose One)

### Option 1: Fresh Database (Recommended)
If you can recreate your database:

```bash
# Drop and recreate (WARNING: loses all data)
psql $DATABASE_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Apply the complete updated schema
psql $DATABASE_URL -f schema/enterprise-schema.sql
```

### Option 2: Patch Existing Database
If you need to keep existing data, apply ALL patches in order:

```bash
# 1. Authentication columns
psql $DATABASE_URL -f schema/auth-columns-patch.sql

# 2. Session device_info column
psql $DATABASE_URL -f schema/session-device-info-patch.sql

# 3. Conversation tables
psql $DATABASE_URL -f schema/conversation-tables-patch.sql
```

## ✅ Verification

After applying either fix, verify it worked:

```bash
psql $DATABASE_URL -c "\d \"user\""
```

You should see these columns:
- ✅ username
- ✅ password_hash
- ✅ email_verified
- ✅ failed_login_attempts
- ✅ locked_until
- ✅ last_login_at

## 🚀 Then Restart Your API

```bash
npm start
```

The signup/login should now work!

## 📝 What Was Fixed?

The enterprise schema was missing password authentication columns. The fix adds:

| Column | Purpose |
|--------|---------|
| `username` | User's login name |
| `password_hash` | Bcrypt password hash |
| `email_verified` | Email verification status |
| `failed_login_attempts` | Rate limiting counter |
| `locked_until` | Account lockout timestamp |
| `last_login_at` | Last login tracking |

## ❓ Still Having Issues?

See **MIGRATION_GUIDE.md** for complete documentation.
