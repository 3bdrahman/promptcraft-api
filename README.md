# PromptCraft API

Express.js backend for PromptCraft - handles authentication, templates, contexts, teams, and AI integrations.

## Architecture

```
┌─────────────────────┐
│  craft-site         │  ← React Web App (Port 3000)
│  (Frontend)         │     Development proxy: /api → :3001/api
└──────────┬──────────┘
           │ HTTP/REST
           ↓
┌─────────────────────┐
│  promptcraft-api    │  ← Express API Server (Port 3001)
│  (Backend)          │     app.use('/api', router)
└──────────┬──────────┘
           │
           ↓
   PostgreSQL Database
    (Neon/Supabase)
```

## Quick Start

### Prerequisites

- **Node.js 16+** and **npm 7+**
- **PostgreSQL database** (Neon, Supabase, or local)
- **Resend API key** for email invitations (optional)

### 1. Install Dependencies

```bash
cd promptcraft-api
npm install
```

### 2. Configure Environment

Create `.env` file in project root:

```bash
PORT=3001
NODE_ENV=development

# Database (Required)
DATABASE_URL=postgresql://user:password@host:5432/database?sslmode=require

# JWT Secrets (Required)
JWT_SECRET=your-secret-key-here
JWT_REFRESH_SECRET=your-refresh-secret-here

# Email Service (Required for invitations)
RESEND_API_KEY=re_xxxxxxxxxxxxx

# CORS Configuration
ALLOWED_ORIGINS=http://localhost:3000,chrome-extension://

# AI Services (Optional - for Prompt Lab features)
OPENAI_API_KEY=sk-xxxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx
HUGGINGFACE_API_KEY=hf_xxxxxxxxxxxxx
```

### 3. Run Development Server

```bash
npm run dev
```

Server starts at: **http://localhost:3001**

You should see:
```
🚀 PromptCraft API Server running on http://localhost:3001
🌍 Environment: development
📊 Database connected
```

### 4. Verify API is Running

```bash
curl http://localhost:3001/health
```

Should return:
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "timestamp": "2024-11-10T...",
    "environment": "development"
  }
}
```

---

## Project Structure

```
promptcraft-api/
├── src/
│   ├── server.js              # Main Express server
│   ├── routes/
│   │   ├── index.js           # Main API router
│   │   └── handlers/          # Endpoint handlers
│   │       ├── auth/          # Authentication
│   │       ├── teams/         # Team management
│   │       ├── contexts/      # Context system
│   │       ├── ai/            # AI integrations
│   │       ├── templates.js   # Templates CRUD
│   │       ├── layers.js      # Context layers
│   │       └── ...
│   ├── middleware/
│   │   └── auth/              # JWT middleware
│   ├── services/              # Business logic
│   └── utils/                 # Utilities
│       ├── database.js        # DB connection
│       ├── responses.js       # Response helpers
│       ├── email.js           # Email service
│       └── ...
├── .env                       # Environment variables
├── .env.example               # Environment template
└── package.json
```

---

## Tech Stack

- **Express 4.18** - Web framework
- **PostgreSQL** - Primary database (via Neon/Supabase)
- **JWT** - Authentication (jsonwebtoken)
- **Bcrypt** - Password hashing
- **Resend** - Email service for invitations
- **Axios** - HTTP client for AI providers
- **CORS** - Cross-origin resource sharing
- **Nodemon** - Development auto-reload

## API Endpoints

All endpoints are prefixed with `/api` in production and development.

### Authentication (`/api/auth`)
- `POST /api/auth/signup` - Register new user
  - Body: `{ email, password, name }`
  - Returns: User object
- `POST /api/auth/verify-pin` - Verify email with PIN
  - Body: `{ email, pin }`
  - Returns: `{ accessToken, refreshToken, user }`
- `POST /api/auth/login` - Login with email/password
  - Body: `{ email, password }`
  - Returns: `{ accessToken, refreshToken, user }`
- `POST /api/auth/refresh` - Refresh access token
  - Body: `{ refreshToken }`
  - Returns: `{ accessToken }`
- `POST /api/auth/logout` - Logout (invalidate refresh token)
  - Headers: `Authorization: Bearer <token>`

### Templates (`/api/templates`)

**Basic CRUD:**
- `GET /api/templates` - List public templates with filters
  - Query params: `category`, `tags`, `search`, `sort`, `limit`, `offset`
  - Returns: Array of templates
- `GET /api/templates/my-templates` - List user's private templates
  - Query params: same as above
  - Returns: Array of templates
- `GET /api/templates/team/:teamId` - Get team templates
  - Returns: Array of team-shared templates
- `GET /api/templates/:id` - Get single template
  - Returns: Template object
- `POST /api/templates` - Create new template
  - Body: `{ name, description, content, category, tags, variables }`
  - Returns: Created template
- `PUT /api/templates/:id` - Update template
  - Body: Partial template fields
  - Returns: Updated template (triggers auto-versioning)
- `DELETE /api/templates/:id` - Soft delete template
  - Returns: `{ deleted: true }`
- `POST /api/templates/:id/use` - Track template usage
  - Returns: Updated usage count
- `POST /api/templates/:id/favorite` - Toggle favorite
  - Returns: Updated favorite status

**Team Collaboration:**
- `POST /api/templates/:id/share` - Share template with team
  - Body: `{ team_id }`
  - Returns: `{ success: true, template: {...} }`
- `POST /api/templates/:id/unshare` - Unshare template (make private)
  - Returns: `{ success: true, template: {...} }`

**Version History:**
- `GET /api/templates/:id/versions` - Get version history
  - Returns: `{ template_id, versions: [...], total: N }`
  - Versions include: version_number, content, created_at, created_by, change_summary, is_current
- `GET /api/templates/:id/versions/:versionId` - Get specific version
  - Returns: `{ version: {...} }`
- `POST /api/templates/:id/revert/:versionId` - Revert to a previous version
  - Creates new version with old content
  - Returns: `{ success: true, message: "Template reverted" }`
- `POST /api/templates/:id/versions` - Create manual version snapshot
  - Body: `{ change_summary: "Description of changes" }`
  - Returns: `{ success: true, version_id: "..." }`

**Dependency Tracking:**
- `GET /api/templates/:id/dependencies` - Get what this template depends on
  - Returns: `{ dependencies: [{type, name, is_required, resource_exists}] }`
  - Types: 'variable', 'context_layer', 'template'
- `GET /api/templates/:id/dependents` - Get what depends on this template
  - Returns: `{ dependents: [{dependent_id, dependent_name, dependency_count}] }`
  - Impact analysis for deletion/changes
- `GET /api/templates/:id/suggested-contexts` - Get smart context suggestions
  - Returns: `{ suggested_contexts: [{layer_id, layer_name, usage_count, last_used}] }`
  - Based on user's usage patterns
- `POST /api/templates/:id/track-usage` - Track template-context usage
  - Body: `{ layer_id }`
  - Updates usage relationship for suggestions
  - Returns: `{ success: true }`

### Context Layers (`/api/contexts/layers`)

**Basic CRUD:**
- `GET /api/contexts/layers` - List context layers with filters
  - Query params: `type`, `tags`, `visibility`, `search`, `sort`, `limit`, `offset`
  - Layer types: `profile`, `project`, `task`, `snippet`, `adhoc`
  - Returns: Array of layers
- `GET /api/contexts/layers/team/:teamId` - Get team context layers
  - Returns: Array of team-shared layers
- `GET /api/contexts/layers/search` - Search layers
  - Query params: `q`, `limit`
  - Returns: `{ layers: [...] }`
- `GET /api/contexts/layers/:id` - Get single layer
  - Returns: `{ layer: {...} }`
- `POST /api/contexts/layers` - Create new layer
  - Body: `{ name, description, content, layer_type, tags, metadata }`
  - Returns: `{ layer: {...} }`
- `PUT /api/contexts/layers/:id` - Update layer
  - Body: Partial layer fields
  - Returns: `{ layer: {...} }` (triggers auto-versioning)
- `DELETE /api/contexts/layers/:id` - Soft delete layer
  - Returns: `{ id, name, deleted: true }`
- `POST /api/contexts/layers/:id/use` - Track layer usage
  - Returns: `{ id, usage_count }`
- `POST /api/contexts/layers/:id/rating` - Rate layer
  - Body: `{ rating }` (1-5)
  - Returns: `{ id, avg_rating, favorite_count }`

**Team Collaboration:**
- `POST /api/contexts/layers/:id/share` - Share layer with team
  - Body: `{ team_id }`
  - Returns: `{ success: true, layer: {...} }`
- `POST /api/contexts/layers/:id/unshare` - Unshare layer (make private)
  - Returns: `{ success: true, layer: {...} }`

**Version History:**
- `GET /api/contexts/layers/:id/versions` - Get version history
  - Returns: `{ layer_id, versions: [...], total: N }`
- `GET /api/contexts/layers/:id/versions/:versionId` - Get specific version
  - Returns: `{ version: {...} }`
- `POST /api/contexts/layers/:id/revert/:versionId` - Revert to a previous version
  - Creates new version with old content
  - Returns: `{ success: true, message: "Layer reverted" }`
- `POST /api/contexts/layers/:id/versions` - Create manual version snapshot
  - Body: `{ change_summary: "Description of changes" }`
  - Returns: `{ success: true, version_id: "..." }`

### Teams (`/api/teams`)
- `GET /api/teams` - List user's teams
  - Returns: Array of teams with role info
- `GET /api/teams/:id` - Get team details
  - Returns: Team object
- `POST /api/teams` - Create new team
  - Body: `{ name, description }`
  - Returns: Created team
- `PUT /api/teams/:id` - Update team
  - Body: `{ name, description }`
  - Returns: Updated team
- `DELETE /api/teams/:id` - Delete team
  - Returns: `{ deleted: true }`
- `GET /api/teams/:id/members` - List team members
  - Returns: Array of members with roles
- `POST /api/teams/:id/invitations` - Invite member to team
  - Body: `{ email, role }` (role: owner, admin, member)
  - Returns: Invitation object
- `DELETE /api/teams/:id/members/:userId` - Remove team member
  - Returns: `{ removed: true }`

### AI / Prompt Lab (`/api/ai`)
- `POST /api/ai/generate` - Generate AI completion
  - Body: `{ provider, model, prompt, parameters }`
  - Providers: `openai`, `anthropic`, `huggingface`, `ollama`
  - Returns: AI response
- `POST /api/ai/embeddings` - Generate text embeddings
  - Body: `{ provider, model, text }`
  - Returns: Embedding vector
- `GET /api/ai/providers` - List available AI providers
  - Returns: `{ providers: [...] }` with status

### Utility
- `GET /health` - Health check endpoint
  - Returns: `{ status: "ok", timestamp, environment }`
- `GET /api` - List all available endpoints
  - Returns: Array of endpoint info

---

## Routing Architecture

### Express Path Stripping Behavior

Understanding how Express handles route matching is critical for development:

**Route Registration** (in `src/routes/index.js`):
```javascript
// Main app strips /api prefix
app.use('/api', router);

// Router registers handlers with additional prefixes
router.use('/templates', asyncHandler(templatesHandler));
router.use('/contexts/layers', asyncHandler(layersHandler));
router.use('/teams', asyncHandler(teamsHandler));
```

**Path Stripping Cascade**:
```
Client Request: GET /api/contexts/layers?type=profile
        ↓
Express receives: GET /api/contexts/layers
        ↓ (app.use('/api', router) strips /api)
Router receives: GET /contexts/layers
        ↓ (router.use('/contexts/layers', handler) strips /contexts/layers)
Handler receives: GET /
        ↓
Handler checks: pathParts.length === 0 ✓ (list endpoint)
```

**Key Points**:
- `app.use('/prefix', handler)` **strips** the prefix before passing to handler
- Use `router.use()` not `router.all()` for nested routes
- The wildcard `*` in `router.all('/path*')` doesn't match `/` characters
- Handlers only see the **remaining path** after all prefix stripping

### Handler Path Matching Pattern

Example from `src/routes/handlers/layers.js`:

```javascript
export default async function handler(req, res) {
  const { method, url } = req;

  // Parse URL - handler sees only path AFTER /api/contexts/layers is stripped
  const urlObj = new URL(url, `https://${req.headers.host || 'localhost'}`);
  const pathParts = urlObj.pathname.split('/').filter(Boolean);

  // GET / - List layers (pathParts.length === 0)
  if (method === 'GET' && pathParts.length === 0) {
    // Handle: GET /api/contexts/layers
  }

  // GET /search - Search layers (pathParts[0] === 'search')
  if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'search') {
    // Handle: GET /api/contexts/layers/search
  }

  // GET /:id - Get single layer (pathParts.length === 1)
  if (method === 'GET' && pathParts.length === 1 && pathParts[0] !== 'search') {
    const layerId = pathParts[0];
    // Handle: GET /api/contexts/layers/:id
  }

  // POST /:id/use - Track usage (pathParts.length === 2)
  if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'use') {
    const layerId = pathParts[0];
    // Handle: POST /api/contexts/layers/:id/use
  }
}
```

### CORS Configuration

**Development**: Frontend proxy handles CORS (see craft-site/setupProxy.js)

**Production**: Server handles CORS directly:
```javascript
// src/server.js
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
```

Set `ALLOWED_ORIGINS` in .env:
```bash
ALLOWED_ORIGINS=https://app.promptcraft.com,chrome-extension://your-extension-id
```

---

## Development

### Available Scripts

```bash
npm start       # Production server
npm run dev     # Development with nodemon (auto-restart on file changes)
npm test        # Run tests (when implemented)
```

### Testing Endpoints

Use Postman, Thunder Client, or curl:

```bash
# Health check
curl http://localhost:3001/health

# List endpoints
curl http://localhost:3001/api

# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password"}'

# Get templates (with auth)
curl http://localhost:3001/api/templates \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Deployment

### Option 1: VPS (DigitalOcean, Linode, etc.)

```bash
# On server
git clone <your-repo>
cd promptcraft-api
npm install --production
cp .env.example .env
# Edit .env with production values

# Start with PM2
npm install -g pm2
pm2 start src/server.js --name promptcraft-api
pm2 save
pm2 startup
```

### Option 2: Railway

1. Connect GitHub repo
2. Add environment variables in Railway dashboard
3. Deploy automatically

### Option 3: Render

1. Create new Web Service
2. Point to GitHub repo
3. Build: `npm install`
4. Start: `npm start`
5. Add environment variables

### Option 4: Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3001
CMD ["npm", "start"]
```

```bash
docker build -t promptcraft-api .
docker run -p 3001:3001 --env-file .env promptcraft-api
```

---

## Environment Variables

### Required

```bash
PORT=3001
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@host:5432/db
JWT_SECRET=your-secret-key
JWT_REFRESH_SECRET=your-refresh-secret
RESEND_API_KEY=re_xxxxxxxxxxxxx
```

### Optional

```bash
# AI Services
OPENAI_API_KEY=sk-xxxxxxxxxxxxx
HUGGINGFACE_API_KEY=hf_xxxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx

# CORS
ALLOWED_ORIGINS=https://app.promptcraft.com,chrome-extension://your-id

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

---

## Migration from Vercel

This API was migrated from Vercel serverless functions to a standard Express server for:
- Better local development experience
- Self-hosting flexibility
- WebSocket support (future)
- Lower costs at scale

All endpoints remain the same - just change the base URL from Vercel to your server.

---

## Troubleshooting

### Port 3001 Already in Use

**Symptoms**: Error `EADDRINUSE :::3001` when starting server

**Solutions**:
```bash
# Option 1: Kill port (Windows)
npx kill-port 3001

# Option 2: Kill port (macOS/Linux)
lsof -i :3001
kill -9 <PID>

# Option 3: Use different port
PORT=3002 npm run dev
```

**Common causes**:
- Previous server instance didn't shut down properly
- Nodemon restart loop due to file changes
- Another application using port 3001

### 404 Not Found - "Route GET /path not found"

**Recent Fix (November 2024)**: We resolved routing issues caused by incorrect path matching in handlers.

**Symptoms**:
- API returns 404 errors for valid endpoints
- Error message: "Route GET /contexts/layers not found"
- Frontend sees 404 in browser console

**Root cause**:
Handlers expected incorrect path lengths due to not accounting for Express prefix stripping.

**How it was fixed**:
1. Changed route registration from `router.all('/path*')` to `router.use('/path')`
2. Updated handlers to check correct path lengths:
   - List endpoint: `pathParts.length === 0` (not 2 or 3)
   - Single item: `pathParts[0]` (not pathParts[2])
3. Added proper path parsing in all handlers

**If you encounter this**:
1. Check `src/routes/index.js` uses `router.use()` not `router.all()`
2. Verify handler path matching accounts for stripped prefixes
3. Review "Routing Architecture" section above
4. Check server logs for actual path received

### Database Connection Failed

**Symptoms**: Error connecting to PostgreSQL, server won't start

**Solutions**:
- Verify `DATABASE_URL` in .env is correct
- Test database connection: `psql <DATABASE_URL>`
- Check database is accessible (firewall, VPN, etc.)
- Ensure `?sslmode=require` is in connection string for cloud databases
- Verify database user has correct permissions

**Common issues**:
- Neon/Supabase requires SSL: Add `?sslmode=require` to DATABASE_URL
- Connection pooler vs direct connection - use pooler for better performance
- IP allowlist - ensure your IP is allowed (or use `0.0.0.0/0` for testing)

### CORS Errors in Browser

**Symptoms**:
- `Access to fetch at '...' has been blocked by CORS policy`
- Frontend can't make requests to backend

**Solutions for development**:
- Ensure `ALLOWED_ORIGINS=http://localhost:3000` in .env
- Restart backend server after changing .env
- Check frontend proxy is configured (craft-site/setupProxy.js)
- Clear browser cache and localStorage

**Solutions for production**:
- Add production domain to `ALLOWED_ORIGINS`
- Example: `ALLOWED_ORIGINS=https://app.promptcraft.com,https://www.promptcraft.com`
- Restart server after changing environment variables

### Frontend 504 Gateway Timeout

**Symptoms**: Frontend shows 504 errors when making API requests

**Root cause**: Backend server not running

**Solution**:
1. Start backend: `cd promptcraft-api && npm run dev`
2. Verify: `curl http://localhost:3001/health`
3. Check backend is listening on correct port (3001)
4. Ensure `REACT_APP_API_URL=http://localhost:3001` in frontend .env

### Server Restart Loop

**Symptoms**: Server keeps restarting infinitely with nodemon

**Solutions**:
1. Kill all node processes: `npx kill-port 3001`
2. Check for syntax errors in recently edited files
3. Verify no circular dependencies
4. Check nodemon isn't watching `node_modules` or build files
5. Clear nodemon cache: `rm -rf node_modules/.cache`

### Authentication Errors

**Symptoms**: 401 Unauthorized, token validation fails

**Solutions**:
- Verify `JWT_SECRET` is set in .env
- Check token isn't expired (access tokens expire in 15min)
- Use refresh token to get new access token
- Clear localStorage in browser and login again
- Ensure `Authorization: Bearer <token>` header is sent correctly

### Email Invitations Not Sending

**Symptoms**: Team invitations fail to send

**Solutions**:
- Verify `RESEND_API_KEY` is set in .env
- Check Resend dashboard for API key status
- Verify email domain is verified in Resend
- Check server logs for Resend API errors
- Test API key: `curl https://api.resend.com/emails -H "Authorization: Bearer $RESEND_API_KEY"`

---

## Recent Updates

### January 2025 - Phase 3: Advanced Features Complete ✅

**Version History System:**
- ✅ Added `template_versions` and `context_layer_versions` tables
- ✅ Implemented auto-versioning triggers on every UPDATE
- ✅ Created version history API endpoints for templates and contexts
- ✅ Added functions: `create_template_version()`, `revert_template_to_version()`, etc.
- ✅ Migration: `add_version_history.sql` (392 lines)

**Team Collaboration:**
- ✅ Added `team_id` and `visibility` columns to templates and context_layers
- ✅ Implemented team sharing endpoints: `/share` and `/unshare`
- ✅ Created helper functions: `share_template_with_team()`, `user_has_template_access()`
- ✅ Added `/team/:teamId` endpoints for getting team resources
- ✅ Migration: `add_team_sharing.sql` (150 lines)

**Dependency Tracking:**
- ✅ Added `template_dependencies`, `layer_dependencies`, `usage_relationships` tables
- ✅ Implemented automatic variable extraction from templates
- ✅ Created dependency analysis endpoints: `/dependencies`, `/dependents`, `/suggested-contexts`
- ✅ Added smart context suggestions based on usage patterns
- ✅ Track template-context usage relationships for recommendations
- ✅ Migration: `add_dependency_tracking.sql` (332 lines)

**New Endpoints (40+):**
- Templates: 16 new endpoints (versions, dependencies, team sharing)
- Contexts: 12 new endpoints (versions, team sharing)
- Total: 28+ new API endpoints added

**Database Changes:**
- 3 new major migrations
- 8 new tables (versions, dependencies, relationships)
- 12+ new PostgreSQL functions
- 6+ new triggers for auto-versioning and dependency detection

### November 2024 - Routing Architecture Fixes

- ✅ Fixed 404 errors caused by incorrect path matching in handlers
- ✅ Changed from `router.all('/path*')` to `router.use('/path')` for proper sub-routing
- ✅ Updated all handlers to account for Express prefix stripping cascade
- ✅ Fixed pathParts index access (pathParts[0] instead of pathParts[2])
- ✅ Added comprehensive routing documentation
- ✅ Improved error handling and logging
- ✅ All endpoints now working correctly with frontend

**Key architectural learning**: Express strips prefixes at each `app.use()` level. With `app.use('/api', router)` then `router.use('/contexts/layers', handler)`, the handler receives only the path after BOTH prefixes are stripped.

---

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Make changes and test locally
4. Ensure all routes follow the documented path matching pattern
5. Test with frontend (craft-site) if making API changes
6. Commit changes (`git commit -m 'Add amazing feature'`)
7. Push to branch (`git push origin feature/amazing-feature`)
8. Open Pull Request

---

## License

MIT License - see LICENSE file for details

## Support

**Issues**: Report bugs via GitHub Issues

**Development Questions**: Check "Routing Architecture" section first

**Database Issues**: Verify DATABASE_URL and check Neon/Supabase dashboard

**Authentication**: Check JWT_SECRET is set and tokens aren't expired

---

**Version:** 1.0.0
**Node Version:** 16+
**License:** MIT
