# PromptCraft API

**Express backend for PromptCraft - handles authentication, templates, contexts, teams, and AI integrations.**

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your database credentials and API keys
```

Required environment variables:
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret for access tokens
- `JWT_REFRESH_SECRET` - Secret for refresh tokens
- `RESEND_API_KEY` - For email invitations

Optional (for AI features):
- `OPENAI_API_KEY`
- `HUGGINGFACE_API_KEY`
- `ANTHROPIC_API_KEY`

### 3. Run Development Server

```bash
npm run dev
```

Server starts at: **http://localhost:3001**

### 4. Test API

```bash
curl http://localhost:3001/health
```

Should return:
```json
{
  "status": "ok",
  "timestamp": "...",
  "environment": "development"
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

## API Endpoints

### Authentication
- `POST /api/auth/signup` - Register new user
- `POST /api/auth/verify-pin` - Verify email with PIN
- `POST /api/auth/login` - Login
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout

### Templates
- `GET /api/templates` - List user templates
- `POST /api/templates` - Create template
- `PUT /api/templates/:id` - Update template
- `DELETE /api/templates/:id` - Delete template

### Contexts
- `GET /api/contexts/layers` - List context layers
- `POST /api/contexts/layers` - Create layer
- `PUT /api/contexts/layers/:id` - Update layer
- `DELETE /api/contexts/layers/:id` - Delete layer

### Teams
- `GET /api/teams` - List user's teams
- `POST /api/teams` - Create team
- `POST /api/teams/:id/invitations` - Invite member
- `GET /api/teams/:id/members` - List team members

### AI (Prompt Lab)
- `POST /api/ai/generate` - Generate AI response
- `POST /api/ai/embeddings` - Generate embeddings
- `GET /api/ai/providers` - List available providers

---

## Development

### Scripts

```bash
npm start       # Production server
npm run dev     # Development with nodemon
npm test        # Run tests
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

### Port Already in Use

```bash
# Find process using port 3001
lsof -i :3001
# Kill it
kill -9 <PID>
```

### Database Connection Failed

- Check DATABASE_URL is correct
- Ensure database is accessible
- Verify firewall rules

### CORS Errors

- Add your origin to ALLOWED_ORIGINS in .env
- Check CORS configuration in server.js

---

## Contributing

1. Create feature branch
2. Make changes
3. Test locally
4. Submit PR

---

**Version:** 1.0.0
**License:** MIT
**Maintainers:** PromptCraft Team
