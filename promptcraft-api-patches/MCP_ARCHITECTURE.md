# PromptCraft MCP Integration Architecture

**Version**: 1.0
**Date**: 2025-11-16
**Status**: Design Document

---

## Overview

This document outlines the **Model Context Protocol (MCP)** integration for PromptCraft, enabling Claude Desktop and other MCP clients to access PromptCraft templates and contexts as a native data source.

### What is MCP?

The Model Context Protocol is an open protocol developed by Anthropic that enables AI assistants to securely access external data sources and tools. Think of it as "plugins for Claude".

### Why MCP for PromptCraft?

**User Benefits:**
- Access your prompt library directly in Claude Desktop
- Search templates/contexts by semantic meaning
- Compose prompts with reusable context layers
- Never leave your conversation to copy/paste prompts

**Platform Benefits:**
- First prompt library with native Claude Desktop integration
- Increased user engagement (used daily in Claude Desktop)
- Competitive differentiation
- Ecosystem leadership position

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Claude Desktop                          │
│                    (MCP Client)                             │
└────────────┬────────────────────────────────────────────────┘
             │ MCP Protocol (stdio/HTTP)
             │
             ↓
┌─────────────────────────────────────────────────────────────┐
│              PromptCraft MCP Server                         │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Tools      │  │  Resources   │  │   Prompts    │     │
│  │  Handler     │  │   Handler    │  │   Handler    │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │              │
│         └──────────────────┴──────────────────┘              │
│                            │                                 │
│                  ┌─────────┴─────────┐                      │
│                  │  API Client       │                      │
│                  │  (with auth)      │                      │
│                  └─────────┬─────────┘                      │
└────────────────────────────┼─────────────────────────────────┘
                             │ HTTPS + JWT
                             ↓
┌─────────────────────────────────────────────────────────────┐
│              PromptCraft API (REST)                         │
│                                                              │
│  - /api/templates  - /api/contexts  - /api/auth           │
│  - Vector search   - Recommendations - Teams               │
└─────────────────────────────────────────────────────────────┘
```

---

## MCP Components

### 1. Tools

Tools are **actions** that Claude can execute. They modify state or perform operations.

#### **Tool: search_templates**
Search templates by semantic meaning or keywords.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query (semantic search enabled)"
    },
    "category": {
      "type": "string",
      "description": "Filter by category (optional)"
    },
    "limit": {
      "type": "number",
      "default": 10
    }
  },
  "required": ["query"]
}
```

**Example:**
```
Claude: I need to find code review templates
Tool Call: search_templates({ query: "code review", limit: 5 })
Result: [
  { id: "...", name: "Comprehensive Code Review", similarity: 0.89 },
  { id: "...", name: "Pull Request Review Checklist", similarity: 0.85 }
]
```

#### **Tool: get_template**
Retrieve a specific template by ID.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "template_id": {
      "type": "string",
      "description": "UUID of the template"
    }
  },
  "required": ["template_id"]
}
```

#### **Tool: fill_template**
Fill a template with variable values and return the completed prompt.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "template_id": {
      "type": "string",
      "description": "UUID of the template"
    },
    "variables": {
      "type": "object",
      "description": "Key-value pairs for template variables"
    },
    "context_ids": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Optional context layer IDs to include"
    }
  },
  "required": ["template_id"]
}
```

**Example:**
```
Tool Call: fill_template({
  template_id: "abc123",
  variables: { "code": "function foo() { ... }", "language": "JavaScript" },
  context_ids: ["profile_123", "project_456"]
})

Result: "You are a senior JavaScript developer...\n\nCode to review:\n\nfunction foo() { ... }"
```

#### **Tool: search_contexts**
Search context layers by semantic meaning.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query"
    },
    "layer_type": {
      "type": "string",
      "enum": ["profile", "project", "task", "snippet"],
      "description": "Filter by layer type (optional)"
    },
    "limit": {
      "type": "number",
      "default": 10
    }
  },
  "required": ["query"]
}
```

#### **Tool: compose_contexts**
Compose multiple context layers into a single prompt.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "context_ids": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Array of context layer IDs"
    },
    "format": {
      "type": "string",
      "enum": ["xml", "markdown", "json"],
      "default": "xml"
    }
  },
  "required": ["context_ids"]
}
```

---

### 2. Resources

Resources are **read-only data** that Claude can access. They represent content.

#### **Resource: template**
URI Pattern: `promptcraft://template/{template_id}`

**Metadata:**
```json
{
  "uri": "promptcraft://template/abc123",
  "name": "Code Review Template",
  "description": "Comprehensive code review checklist",
  "mimeType": "text/plain",
  "metadata": {
    "category": "code.review",
    "tags": ["code", "review", "quality"],
    "variables": ["code", "language", "context"],
    "likes_count": 42,
    "usage_count": 156
  }
}
```

**Content:**
```
You are an expert code reviewer. Review the following {{language}} code:

{{code}}

Context: {{context}}

Provide feedback on:
- Code quality
- Best practices
- Security concerns
- Performance issues
```

#### **Resource: context**
URI Pattern: `promptcraft://context/{context_id}`

**Metadata:**
```json
{
  "uri": "promptcraft://context/def456",
  "name": "Senior TypeScript Developer",
  "description": "Profile for senior TS dev role",
  "mimeType": "text/plain",
  "metadata": {
    "layer_type": "profile",
    "tags": ["typescript", "senior", "fullstack"],
    "priority": 9
  }
}
```

**Content:**
```
You are a senior TypeScript developer with 8+ years of experience.
You specialize in React, Node.js, and cloud architecture.
You value clean code, strong typing, and comprehensive testing.
```

---

### 3. Prompts (Templates)

MCP Prompts are **pre-configured tool invocations** - shortcuts for common operations.

#### **Prompt: use_template**
Quickly fill and use a template.

**Arguments:**
```json
{
  "template_name": {
    "type": "string",
    "description": "Name or ID of template"
  },
  "variables": {
    "type": "object",
    "description": "Template variables"
  }
}
```

**Implementation:**
1. Search for template by name (if not ID)
2. Fill template with variables
3. Return completed prompt

---

## Authentication

### User Authentication Flow

1. **Initial Setup**: User adds MCP server to Claude Desktop config
2. **Authentication**: Server requests API key on first use
3. **Token Storage**: API key stored securely in Claude Desktop
4. **Requests**: Every MCP request includes `Authorization: Bearer <api_key>`

### Security Considerations

- API keys scoped to user account
- Rate limiting per API key
- Audit logging for MCP requests
- Read-only access by default (no template modification via MCP)

---

## Implementation

### Technology Stack

**MCP Server:**
- **Runtime**: Node.js 18+
- **Framework**: `@modelcontextprotocol/sdk` (official SDK)
- **Transport**: stdio (for Claude Desktop), HTTP/SSE (for web clients)
- **API Client**: Axios for PromptCraft API calls

### Directory Structure

```
promptcraft-mcp/
├── src/
│   ├── index.ts              # Main server entry point
│   ├── server.ts             # MCP server setup
│   ├── tools/                # Tool implementations
│   │   ├── search_templates.ts
│   │   ├── get_template.ts
│   │   ├── fill_template.ts
│   │   ├── search_contexts.ts
│   │   └── compose_contexts.ts
│   ├── resources/            # Resource handlers
│   │   ├── templates.ts
│   │   └── contexts.ts
│   ├── prompts/              # Prompt templates
│   │   └── use_template.ts
│   ├── api/                  # PromptCraft API client
│   │   ├── client.ts
│   │   └── auth.ts
│   └── utils/
│       ├── logger.ts
│       └── errors.ts
├── package.json
├── tsconfig.json
└── README.md
```

---

## User Experience

### Claude Desktop Integration

**1. Installation**

User adds to Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "promptcraft": {
      "command": "npx",
      "args": ["-y", "@promptcraft/mcp-server"],
      "env": {
        "PROMPTCRAFT_API_KEY": "pc_user_xxx",
        "PROMPTCRAFT_API_URL": "https://api.promptcraft.app"
      }
    }
  }
}
```

**2. Usage in Conversation**

```
User: Help me review this TypeScript code

Claude: I can help with that! Let me search for a code review template from your PromptCraft library.

[Uses search_templates tool]

Claude: I found your "TypeScript Code Review Checklist" template. Let me fill it with your code and review it.

[Uses fill_template tool]

Claude: [Provides code review using the template]
```

**3. Resource Discovery**

Claude can see available templates/contexts:

```
User: What prompt templates do I have for API documentation?

Claude: Let me check your PromptCraft library...

[Uses search_templates with query "API documentation"]

Claude: You have 3 templates for API documentation:
1. REST API Documentation Generator
2. OpenAPI Spec Writer
3. API Endpoint Descriptions

Would you like me to use one of these?
```

---

## Deployment

### Packaging

**NPM Package**: `@promptcraft/mcp-server`

```bash
# Installation
npm install -g @promptcraft/mcp-server

# Or via npx (no install needed)
npx @promptcraft/mcp-server
```

### Configuration

**Environment Variables:**
```bash
PROMPTCRAFT_API_KEY=pc_user_xxx      # Required: User's API key
PROMPTCRAFT_API_URL=https://api.promptcraft.app  # Optional: API endpoint
LOG_LEVEL=info                        # Optional: Logging level
```

**Config File**: `.promptcraftrc`
```json
{
  "apiKey": "pc_user_xxx",
  "apiUrl": "https://api.promptcraft.app",
  "cache": {
    "enabled": true,
    "ttl": 300
  }
}
```

---

## Phase 1 Scope (MVP)

**Tools (5):**
- ✅ search_templates
- ✅ get_template
- ✅ fill_template
- ✅ search_contexts
- ✅ compose_contexts

**Resources (2):**
- ✅ Template resources
- ✅ Context resources

**Prompts (1):**
- ✅ use_template

**Features:**
- Read-only access (no creation/modification)
- Semantic search integration
- Template variable filling
- Context composition
- Basic caching
- Error handling

**Out of Scope (Phase 2):**
- Template creation/modification
- Team collaboration features
- Real-time updates
- Advanced analytics
- Workflow execution

---

## Success Metrics

1. **Adoption**: % of users who enable MCP integration
2. **Usage**: MCP requests per user per day
3. **Engagement**: Templates accessed via MCP vs web
4. **Retention**: User retention for MCP-enabled users
5. **Discovery**: Templates discovered via MCP search

---

## Next Steps

1. ✅ Design architecture (this document)
2. 🔄 Implement MCP server (TypeScript)
3. 🔄 Create API client with authentication
4. 🔄 Implement tool handlers
5. 🔄 Implement resource handlers
6. 🔄 Test with Claude Desktop
7. 🔄 Package as NPM module
8. 🔄 Write user documentation
9. 🔄 Beta testing with select users
10. 🔄 Public release

---

**Status**: Ready for Implementation
**Owner**: PromptCraft Team
**Timeline**: 2-3 days for MVP
