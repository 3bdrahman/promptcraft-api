/**
 * Context Extraction Handler
 *
 * AI-powered extraction of contexts from various sources:
 * - Files (PDF, DOCX, TXT, MD, code files)
 * - URLs (web pages, documentation)
 * - Text (raw text input)
 * - Repositories (GitHub/GitLab repos)
 *
 * @module handlers/contexts/extraction
 */

import { db } from '../../../utils/database.js';
import { getUserId } from '../../../utils/auth.js';
import { success, error } from '../../../utils/responses.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';

// Initialize AI clients
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

/**
 * POST /api/extraction/from-file
 * Extract contexts from uploaded file
 *
 * Body (multipart/form-data):
 * - file: File to extract from
 * - options: JSON string with extraction options
 *   - mode: 'auto'|'documentation'|'tutorial'|'examples'|'reference'
 *   - max_contexts: Maximum number of contexts to extract (default 10)
 *   - min_quality: Minimum quality threshold 0-1 (default 0.7)
 */
export async function extractFromFile(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    // In Express with multer middleware, file would be in req.file
    // For now, handle as base64 or text in body
    const {
      file_content,
      file_name,
      file_type,
      options = {}
    } = req.body;

    if (!file_content) {
      return res.status(400).json(error('file_content is required'));
    }

    const {
      mode = 'auto',
      max_contexts = 10,
      min_quality = 0.7
    } = options;

    // Parse file content based on type
    let parsedContent;
    try {
      parsedContent = parseFileContent(file_content, file_type, file_name);
    } catch (err) {
      return res.status(400).json(error(`Failed to parse file: ${err.message}`));
    }

    // Extract contexts using AI
    const extracted = await extractContextsWithAI(
      parsedContent,
      mode,
      max_contexts,
      'file',
      { file_name, file_type }
    );

    // Filter by quality threshold
    const filtered = extracted.contexts.filter(c => c.quality_score >= min_quality);

    return res.json(success({
      source: 'file',
      source_name: file_name,
      extraction_mode: mode,
      total_extracted: filtered.length,
      contexts: filtered,
      metadata: {
        original_count: extracted.contexts.length,
        filtered_count: filtered.length,
        file_type,
        extraction_time_ms: extracted.extraction_time_ms
      }
    }));

  } catch (err) {
    console.error('Extract from file error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/extraction/from-text
 * Extract contexts from raw text
 *
 * Body:
 * - text: Text to extract from
 * - options: Extraction options (same as from-file)
 */
export async function extractFromText(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      text,
      options = {}
    } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json(error('text is required'));
    }

    const {
      mode = 'auto',
      max_contexts = 10,
      min_quality = 0.7
    } = options;

    // Extract contexts using AI
    const extracted = await extractContextsWithAI(
      text,
      mode,
      max_contexts,
      'text'
    );

    // Filter by quality threshold
    const filtered = extracted.contexts.filter(c => c.quality_score >= min_quality);

    return res.json(success({
      source: 'text',
      extraction_mode: mode,
      total_extracted: filtered.length,
      contexts: filtered,
      metadata: {
        original_count: extracted.contexts.length,
        filtered_count: filtered.length,
        text_length: text.length,
        extraction_time_ms: extracted.extraction_time_ms
      }
    }));

  } catch (err) {
    console.error('Extract from text error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/extraction/from-url
 * Extract contexts from a web URL
 *
 * Body:
 * - url: URL to extract from
 * - options: Extraction options
 */
export async function extractFromURL(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      url,
      options = {}
    } = req.body;

    if (!url) {
      return res.status(400).json(error('url is required'));
    }

    // Validate URL
    try {
      new URL(url);
    } catch (e) {
      return res.status(400).json(error('Invalid URL'));
    }

    const {
      mode = 'auto',
      max_contexts = 10,
      min_quality = 0.7
    } = options;

    // Fetch web content
    let webContent;
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'PromptCraft Context Extractor/1.0'
        }
      });
      webContent = response.data;
    } catch (err) {
      return res.status(400).json(error(`Failed to fetch URL: ${err.message}`));
    }

    // Clean HTML (basic cleaning - in production use a library like cheerio)
    const cleanedContent = cleanHTML(webContent);

    // Extract contexts using AI
    const extracted = await extractContextsWithAI(
      cleanedContent,
      mode,
      max_contexts,
      'url',
      { url }
    );

    // Filter by quality threshold
    const filtered = extracted.contexts.filter(c => c.quality_score >= min_quality);

    return res.json(success({
      source: 'url',
      source_url: url,
      extraction_mode: mode,
      total_extracted: filtered.length,
      contexts: filtered,
      metadata: {
        original_count: extracted.contexts.length,
        filtered_count: filtered.length,
        content_length: cleanedContent.length,
        extraction_time_ms: extracted.extraction_time_ms
      }
    }));

  } catch (err) {
    console.error('Extract from URL error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * POST /api/extraction/from-repo
 * Extract contexts from a code repository
 *
 * Body:
 * - repo_url: Repository URL (GitHub/GitLab)
 * - options: Extraction options
 *   - paths: Specific paths to extract from (optional)
 *   - file_types: File types to include (optional)
 */
export async function extractFromRepo(req, res) {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res.status(401).json(error('Unauthorized', 401));
    }

    const {
      repo_url,
      options = {}
    } = req.body;

    if (!repo_url) {
      return res.status(400).json(error('repo_url is required'));
    }

    const {
      mode = 'auto',
      max_contexts = 10,
      min_quality = 0.7,
      paths = [],
      file_types = []
    } = options;

    // Parse repository URL
    const repoInfo = parseRepoURL(repo_url);
    if (!repoInfo) {
      return res.status(400).json(error('Invalid repository URL'));
    }

    // Fetch repository contents via GitHub/GitLab API
    let repoContents;
    try {
      repoContents = await fetchRepoContents(repoInfo, paths, file_types);
    } catch (err) {
      return res.status(400).json(error(`Failed to fetch repository: ${err.message}`));
    }

    // Combine relevant files
    const combinedContent = repoContents.files
      .map(f => `// File: ${f.path}\n${f.content}`)
      .join('\n\n');

    // Extract contexts using AI
    const extracted = await extractContextsWithAI(
      combinedContent,
      mode,
      max_contexts,
      'repository',
      { repo_url, ...repoInfo }
    );

    // Filter by quality threshold
    const filtered = extracted.contexts.filter(c => c.quality_score >= min_quality);

    return res.json(success({
      source: 'repository',
      source_url: repo_url,
      extraction_mode: mode,
      total_extracted: filtered.length,
      contexts: filtered,
      metadata: {
        original_count: extracted.contexts.length,
        filtered_count: filtered.length,
        files_scanned: repoContents.files.length,
        repository: repoInfo,
        extraction_time_ms: extracted.extraction_time_ms
      }
    }));

  } catch (err) {
    console.error('Extract from repo error:', err);
    return res.status(500).json(error(err.message, 500));
  }
}

/**
 * Extract contexts using AI (OpenAI or Anthropic)
 */
async function extractContextsWithAI(content, mode, maxContexts, sourceType, metadata = {}) {
  const startTime = Date.now();

  const systemPrompt = buildExtractionPrompt(mode, maxContexts, sourceType);

  // Limit content length to avoid token limits
  const limitedContent = content.slice(0, 50000);

  try {
    let result;

    // Try Claude first (better at extraction)
    if (anthropic) {
      const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `Extract contexts from the following content:\n\n${limitedContent}`
        }]
      });

      result = JSON.parse(response.content[0].text);
    }
    // Fallback to OpenAI
    else if (openai) {
      const response = await openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Extract contexts from the following content:\n\n${limitedContent}` }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3
      });

      result = JSON.parse(response.choices[0].message.content);
    }
    else {
      throw new Error('No AI provider configured');
    }

    return {
      contexts: result.contexts || [],
      extraction_time_ms: Date.now() - startTime
    };

  } catch (err) {
    console.error('AI extraction error:', err);
    return {
      contexts: [],
      extraction_time_ms: Date.now() - startTime
    };
  }
}

/**
 * Build extraction prompt based on mode
 */
function buildExtractionPrompt(mode, maxContexts, sourceType) {
  const base = `You are an expert at extracting reusable contexts from content. Analyze the provided content and extract ${maxContexts} useful contexts.

RESPONSE FORMAT (JSON):
{
  "contexts": [
    {
      "name": "Context Name",
      "description": "Brief description of what this context provides",
      "content": "The extracted context content",
      "layer_type": "project|task|profile|snippet|reference",
      "tags": ["tag1", "tag2"],
      "quality_score": 0.95,
      "metadata": {}
    }
  ]
}

GUIDELINES:
1. Extract self-contained, reusable contexts
2. Each context should be focused on a single topic
3. Include relevant details but avoid redundancy
4. Assign appropriate layer_type based on content nature
5. Add descriptive tags for organization
6. Quality score: 0-1 based on usefulness and clarity
7. Make contexts that would be valuable for prompts`;

  const modeInstructions = {
    auto: 'Automatically detect the best contexts to extract.',
    documentation: 'Focus on extracting documentation, API references, and usage guides.',
    tutorial: 'Extract step-by-step instructions and learning material.',
    examples: 'Extract code examples, use cases, and sample implementations.',
    reference: 'Extract reference material, definitions, and specifications.'
  };

  return base + `\n\nMODE: ${mode}\n${modeInstructions[mode] || modeInstructions.auto}`;
}

/**
 * Parse file content based on type
 */
function parseFileContent(content, fileType, fileName) {
  // If content is base64, decode it
  if (content.startsWith('data:')) {
    const base64Data = content.split(',')[1];
    content = Buffer.from(base64Data, 'base64').toString('utf-8');
  }

  // Handle different file types
  if (fileType === 'application/pdf' || fileName?.endsWith('.pdf')) {
    // In production, use pdf-parse library
    // For now, assume content is already extracted text
    return content;
  }

  if (fileType === 'application/json' || fileName?.endsWith('.json')) {
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(parsed, null, 2);
    } catch (e) {
      return content;
    }
  }

  // Plain text, markdown, code files
  return content;
}

/**
 * Clean HTML content (basic implementation)
 */
function cleanHTML(html) {
  // Remove script tags
  let cleaned = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  // Remove style tags
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  // Remove HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  // Decode HTML entities
  cleaned = cleaned.replace(/&nbsp;/g, ' ');
  cleaned = cleaned.replace(/&amp;/g, '&');
  cleaned = cleaned.replace(/&lt;/g, '<');
  cleaned = cleaned.replace(/&gt;/g, '>');
  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

/**
 * Parse repository URL
 */
function parseRepoURL(url) {
  // GitHub pattern
  const githubMatch = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (githubMatch) {
    return {
      platform: 'github',
      owner: githubMatch[1],
      repo: githubMatch[2].replace('.git', '')
    };
  }

  // GitLab pattern
  const gitlabMatch = url.match(/gitlab\.com\/([^\/]+)\/([^\/]+)/);
  if (gitlabMatch) {
    return {
      platform: 'gitlab',
      owner: gitlabMatch[1],
      repo: gitlabMatch[2].replace('.git', '')
    };
  }

  return null;
}

/**
 * Fetch repository contents
 */
async function fetchRepoContents(repoInfo, paths = [], fileTypes = []) {
  if (repoInfo.platform === 'github') {
    return await fetchGitHubContents(repoInfo, paths, fileTypes);
  }

  throw new Error('Unsupported repository platform');
}

/**
 * Fetch GitHub repository contents
 */
async function fetchGitHubContents(repoInfo, paths, fileTypes) {
  const { owner, repo } = repoInfo;
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;

  try {
    // Get repository tree
    const treeResponse = await axios.get(`${baseUrl}/git/trees/main?recursive=1`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'PromptCraft'
      }
    });

    const tree = treeResponse.data.tree;

    // Filter files based on paths and types
    let filteredFiles = tree.filter(item => item.type === 'blob');

    if (paths.length > 0) {
      filteredFiles = filteredFiles.filter(f =>
        paths.some(p => f.path.startsWith(p))
      );
    }

    if (fileTypes.length > 0) {
      filteredFiles = filteredFiles.filter(f =>
        fileTypes.some(t => f.path.endsWith(t))
      );
    }

    // Limit to 20 files to avoid rate limits
    filteredFiles = filteredFiles.slice(0, 20);

    // Fetch content of each file
    const files = await Promise.all(
      filteredFiles.map(async (file) => {
        try {
          const contentResponse = await axios.get(file.url, {
            headers: {
              'Accept': 'application/vnd.github.v3.raw',
              'User-Agent': 'PromptCraft'
            }
          });

          return {
            path: file.path,
            content: contentResponse.data
          };
        } catch (err) {
          console.error(`Failed to fetch ${file.path}:`, err.message);
          return null;
        }
      })
    );

    return {
      files: files.filter(f => f !== null)
    };

  } catch (err) {
    throw new Error(`GitHub API error: ${err.message}`);
  }
}

export default {
  extractFromFile,
  extractFromText,
  extractFromURL,
  extractFromRepo
};
