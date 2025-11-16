#!/usr/bin/env node

/**
 * PromptCraft MCP Server
 *
 * Model Context Protocol server for accessing PromptCraft templates and contexts
 * in Claude Desktop and other MCP clients.
 *
 * Usage:
 *   promptcraft-mcp
 *   PROMPTCRAFT_API_KEY=xxx promptcraft-mcp
 *
 * @module index
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';

// Import tool implementations
import { searchTemplates } from './tools/search_templates.js';
import { getTemplate } from './tools/get_template.js';
import { fillTemplate } from './tools/fill_template.js';
import { searchContexts } from './tools/search_contexts.js';
import { composeContexts } from './tools/compose_contexts.js';

// Import resource handlers
import { listTemplateResources, readTemplateResource } from './resources/templates.js';
import { listContextResources, readContextResource } from './resources/contexts.js';

// Import API client
import { setApiKey, setApiUrl } from './api/client.js';
import { logger } from './utils/logger.js';

// Load environment variables
dotenv.config();

// Configuration
const API_KEY = process.env.PROMPTCRAFT_API_KEY || '';
const API_URL = process.env.PROMPTCRAFT_API_URL || 'https://api.promptcraft.app';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

if (!API_KEY) {
  console.error('Error: PROMPTCRAFT_API_KEY environment variable is required');
  console.error('');
  console.error('Usage:');
  console.error('  PROMPTCRAFT_API_KEY=your_key promptcraft-mcp');
  console.error('');
  console.error('Get your API key at: https://app.promptcraft.app/settings/api');
  process.exit(1);
}

// Configure API client
setApiKey(API_KEY);
setApiUrl(API_URL);
logger.setLevel(LOG_LEVEL);

/**
 * Create and configure the MCP server
 */
async function main() {
  logger.info('Starting PromptCraft MCP Server...');
  logger.info(`API URL: ${API_URL}`);

  // Create server instance
  const server = new Server(
    {
      name: 'promptcraft',
      version: '1.0.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  /**
   * List available tools
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('Listing tools');

    return {
      tools: [
        {
          name: 'search_templates',
          description:
            'Search for prompt templates by semantic meaning or keywords. Returns matching templates with similarity scores.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query (supports semantic search)',
              },
              category: {
                type: 'string',
                description: 'Filter by category (optional, e.g., "code.review")',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 10)',
                default: 10,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_template',
          description:
            'Retrieve a specific template by ID. Returns the full template including variables and content.',
          inputSchema: {
            type: 'object',
            properties: {
              template_id: {
                type: 'string',
                description: 'UUID of the template',
              },
            },
            required: ['template_id'],
          },
        },
        {
          name: 'fill_template',
          description:
            'Fill a template with variable values and optional context layers. Returns the complete, ready-to-use prompt.',
          inputSchema: {
            type: 'object',
            properties: {
              template_id: {
                type: 'string',
                description: 'UUID of the template',
              },
              variables: {
                type: 'object',
                description: 'Key-value pairs for template variables',
              },
              context_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional context layer IDs to include',
              },
            },
            required: ['template_id'],
          },
        },
        {
          name: 'search_contexts',
          description:
            'Search for context layers by semantic meaning or type. Context layers provide reusable background information for prompts.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
              layer_type: {
                type: 'string',
                enum: ['profile', 'project', 'task', 'snippet'],
                description: 'Filter by layer type (optional)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 10)',
                default: 10,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'compose_contexts',
          description:
            'Compose multiple context layers into a single unified context. Useful for building complex prompts with multiple information sources.',
          inputSchema: {
            type: 'object',
            properties: {
              context_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of context layer IDs to compose',
              },
              format: {
                type: 'string',
                enum: ['xml', 'markdown', 'json'],
                description: 'Output format (default: xml)',
                default: 'xml',
              },
            },
            required: ['context_ids'],
          },
        },
      ],
    };
  });

  /**
   * Handle tool execution
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    logger.info(`Executing tool: ${request.params.name}`);
    logger.debug('Tool arguments:', request.params.arguments);

    try {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'search_templates':
          return await searchTemplates(args);

        case 'get_template':
          return await getTemplate(args);

        case 'fill_template':
          return await fillTemplate(args);

        case 'search_contexts':
          return await searchContexts(args);

        case 'compose_contexts':
          return await composeContexts(args);

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      logger.error(`Tool execution error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });

  /**
   * List available resources
   */
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    logger.debug('Listing resources');

    try {
      const templateResources = await listTemplateResources();
      const contextResources = await listContextResources();

      return {
        resources: [...templateResources, ...contextResources],
      };
    } catch (error) {
      logger.error(`List resources error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });

  /**
   * Read a specific resource
   */
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    logger.info(`Reading resource: ${uri}`);

    try {
      // Parse URI: promptcraft://template/{id} or promptcraft://context/{id}
      const match = uri.match(/^promptcraft:\/\/(template|context)\/(.+)$/);

      if (!match) {
        throw new Error(`Invalid resource URI: ${uri}`);
      }

      const [, resourceType, resourceId] = match;

      if (resourceType === 'template') {
        return await readTemplateResource(resourceId);
      } else if (resourceType === 'context') {
        return await readContextResource(resourceId);
      } else {
        throw new Error(`Unknown resource type: ${resourceType}`);
      }
    } catch (error) {
      logger.error(`Read resource error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });

  /**
   * Start the server with stdio transport
   */
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('PromptCraft MCP Server started successfully');
  logger.info('Waiting for requests from MCP client...');
}

// Run the server
main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
