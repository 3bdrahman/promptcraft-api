/**
 * Context Builder Library
 * Core logic for assembling context from multiple sources
 */

import { db } from './database.js';

export class ContextBuilder {
  constructor(userId) {
    this.userId = userId;
    this.components = [];
    this.totalTokens = 0;
  }

  /**
   * Add user profile to context
   */
  async addProfile(options = { minimal: false }) {
    try {
      const result = await db.query(
        'SELECT * FROM user_profiles WHERE user_id = $1',
        [this.userId]
      );

      if (result.rows.length === 0) {
        return this; // No profile yet, skip
      }

      const profile = result.rows[0];
      const formatted = this.formatProfile(profile, options);

      this.components.push({
        type: 'profile',
        content: formatted,
        tokens: this.estimateTokens(formatted),
        priority: 1 // Highest priority
      });

      return this;
    } catch (error) {
      console.error('Error adding profile:', error);
      return this;
    }
  }

  /**
   * Add project context
   */
  async addProject(projectId, options = {}) {
    try {
      const result = await db.query(
        `SELECT * FROM projects
         WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
        [projectId, this.userId]
      );

      if (result.rows.length === 0) {
        return this;
      }

      const project = result.rows[0];
      const formatted = this.formatProject(project, options);

      this.components.push({
        type: 'project',
        id: projectId,
        content: formatted,
        tokens: this.estimateTokens(formatted),
        priority: 3
      });

      return this;
    } catch (error) {
      console.error('Error adding project:', error);
      return this;
    }
  }

  /**
   * Add task context
   */
  async addTask(taskId, options = { includeProject: false }) {
    try {
      const result = await db.query(
        `SELECT t.*, p.name as project_name
         FROM tasks t
         LEFT JOIN projects p ON t.project_id = p.id
         WHERE t.id = $1 AND t.user_id = $2`,
        [taskId, this.userId]
      );

      if (result.rows.length === 0) {
        return this;
      }

      const task = result.rows[0];
      const formatted = this.formatTask(task, options);

      this.components.push({
        type: 'task',
        id: taskId,
        content: formatted,
        tokens: this.estimateTokens(formatted),
        priority: 2
      });

      // Auto-include project if requested and not already added
      if (options.includeProject && task.project_id) {
        const hasProject = this.components.some(c => c.type === 'project' && c.id === task.project_id);
        if (!hasProject) {
          await this.addProject(task.project_id);
        }
      }

      return this;
    } catch (error) {
      console.error('Error adding task:', error);
      return this;
    }
  }

  /**
   * Add snippets
   */
  async addSnippets(snippetIds, options = {}) {
    try {
      const result = await db.query(
        `SELECT * FROM context_snippets
         WHERE id = ANY($1) AND user_id = $2
         ORDER BY usage_count DESC`,
        [snippetIds, this.userId]
      );

      for (const snippet of result.rows) {
        const formatted = this.formatSnippet(snippet, options);

        this.components.push({
          type: 'snippet',
          id: snippet.id,
          content: formatted,
          tokens: snippet.token_count || this.estimateTokens(formatted),
          priority: 4
        });
      }

      return this;
    } catch (error) {
      console.error('Error adding snippets:', error);
      return this;
    }
  }

  /**
   * Build final context
   */
  build(format = 'markdown') {
    if (this.components.length === 0) {
      return {
        text: '',
        tokens: 0,
        components: []
      };
    }

    // Sort by priority
    const sorted = [...this.components].sort((a, b) => a.priority - b.priority);

    const assembled = this.assembleComponents(sorted, format);
    this.totalTokens = this.estimateTokens(assembled);

    return {
      text: assembled,
      tokens: this.totalTokens,
      components: sorted.map(c => ({
        type: c.type,
        id: c.id,
        tokens: c.tokens
      }))
    };
  }

  /**
   * Optimize context to fit token budget
   */
  async optimize(maxTokens) {
    const initial = this.build();

    if (initial.tokens <= maxTokens) {
      return initial;
    }

    // Priority: Profile > Task > Project > Snippets
    const optimized = [];
    let currentTokens = 0;

    // Sort by priority
    const sorted = [...this.components].sort((a, b) => a.priority - b.priority);

    for (const component of sorted) {
      if (currentTokens + component.tokens <= maxTokens) {
        optimized.push(component);
        currentTokens += component.tokens;
      }
    }

    this.components = optimized;
    return this.build();
  }

  /**
   * Recommend context based on prompt analysis
   */
  async recommend(promptText) {
    const recommendations = {
      snippets: [],
      projects: [],
      tasks: [],
      reasoning: []
    };

    try {
      // Extract keywords from prompt
      const keywords = this.extractKeywords(promptText);

      // Find relevant snippets by tags/content
      const snippetResult = await db.query(
        `SELECT id, name, tags, usage_count, category
         FROM context_snippets
         WHERE user_id = $1
           AND (
             tags && $2::text[]
             OR content ILIKE ANY($3)
           )
         ORDER BY usage_count DESC
         LIMIT 5`,
        [this.userId, keywords, keywords.map(k => `%${k}%`)]
      );

      recommendations.snippets = snippetResult.rows;

      // Find relevant projects
      const projectResult = await db.query(
        `SELECT id, name, tech_stack
         FROM projects
         WHERE user_id = $1
           AND status = 'active'
           AND archived_at IS NULL
           AND (
             tech_stack && $2::text[]
             OR name ILIKE ANY($3)
             OR description ILIKE ANY($3)
           )
         ORDER BY updated_at DESC
         LIMIT 3`,
        [this.userId, keywords, keywords.map(k => `%${k}%`)]
      );

      recommendations.projects = projectResult.rows;

      // Find relevant tasks
      const taskResult = await db.query(
        `SELECT id, name, status, project_id
         FROM tasks
         WHERE user_id = $1
           AND status IN ('todo', 'in-progress', 'blocked')
           AND completed_at IS NULL
           AND (
             name ILIKE ANY($2)
             OR description ILIKE ANY($2)
             OR context_details ILIKE ANY($2)
           )
         ORDER BY priority ASC, updated_at DESC
         LIMIT 5`,
        [this.userId, keywords.map(k => `%${k}%`)]
      );

      recommendations.tasks = taskResult.rows;

      // Generate reasoning
      if (snippetResult.rows.length > 0) {
        recommendations.reasoning.push(
          `Found ${snippetResult.rows.length} relevant snippets based on tags and content`
        );
      }
      if (projectResult.rows.length > 0) {
        recommendations.reasoning.push(
          `Matched ${projectResult.rows.length} active projects`
        );
      }
      if (taskResult.rows.length > 0) {
        recommendations.reasoning.push(
          `Found ${taskResult.rows.length} pending tasks`
        );
      }

      return recommendations;
    } catch (error) {
      console.error('Error getting recommendations:', error);
      return recommendations;
    }
  }

  // ============================================================================
  // FORMATTING METHODS
  // ============================================================================

  formatProfile(profile, options) {
    if (options.minimal) {
      return `**Role:** ${profile.role || 'Developer'}\n**Stack:** ${(profile.primary_tech_stack || []).join(', ')}`;
    }

    const parts = [];

    parts.push('## About Me');

    if (profile.display_name || profile.role) {
      parts.push(`**Name:** ${profile.display_name || 'User'}`);
      parts.push(`**Role:** ${profile.role || 'Developer'}`);
    }

    if (profile.years_experience) {
      parts.push(`**Experience:** ${profile.years_experience} years`);
    }

    if (profile.primary_tech_stack && profile.primary_tech_stack.length > 0) {
      parts.push(`**Tech Stack:** ${profile.primary_tech_stack.join(', ')}`);
    }

    if (profile.industries && profile.industries.length > 0) {
      parts.push(`**Industries:** ${profile.industries.join(', ')}`);
    }

    parts.push(''); // Blank line

    if (profile.preferred_tone || profile.detail_level) {
      parts.push('### Communication Preferences');
      if (profile.preferred_tone) {
        parts.push(`**Tone:** ${profile.preferred_tone}`);
      }
      if (profile.detail_level) {
        parts.push(`**Detail Level:** ${profile.detail_level}`);
      }
      parts.push('');
    }

    if (profile.ai_instructions) {
      parts.push('### AI Instructions');
      parts.push(profile.ai_instructions);
      parts.push('');
    }

    return parts.join('\n');
  }

  formatProject(project, options) {
    const parts = [];

    parts.push(`## Project: ${project.name}`);

    if (project.description) {
      parts.push(project.description);
      parts.push('');
    }

    if (project.tech_stack && project.tech_stack.length > 0) {
      parts.push(`**Tech Stack:** ${project.tech_stack.join(', ')}`);
    }

    if (project.status) {
      parts.push(`**Status:** ${project.status}`);
    }

    if (project.deadline) {
      parts.push(`**Deadline:** ${new Date(project.deadline).toLocaleDateString()}`);
    }

    parts.push('');

    if (project.goals) {
      parts.push('**Goals:**');
      parts.push(project.goals);
      parts.push('');
    }

    if (project.constraints) {
      parts.push('**Constraints:**');
      parts.push(project.constraints);
      parts.push('');
    }

    return parts.join('\n');
  }

  formatTask(task, options) {
    const parts = [];

    parts.push(`## Task: ${task.name}`);

    if (task.project_name) {
      parts.push(`*Project: ${task.project_name}*`);
    }

    parts.push(`**Status:** ${task.status}`);

    if (task.priority) {
      const priorityLabel = ['Low', 'Normal', 'High', 'Urgent'][task.priority - 1] || 'Normal';
      parts.push(`**Priority:** ${priorityLabel}`);
    }

    parts.push('');

    if (task.description) {
      parts.push('**Description:**');
      parts.push(task.description);
      parts.push('');
    }

    if (task.context_details) {
      parts.push('**Context:**');
      parts.push(task.context_details);
      parts.push('');
    }

    if (task.code_snippets && Object.keys(task.code_snippets).length > 0) {
      parts.push('**Relevant Code:**');
      for (const [key, code] of Object.entries(task.code_snippets)) {
        parts.push(`\`\`\`\n${code}\n\`\`\``);
      }
      parts.push('');
    }

    if (task.error_logs) {
      parts.push('**Error Logs:**');
      parts.push('```');
      parts.push(task.error_logs);
      parts.push('```');
      parts.push('');
    }

    return parts.join('\n');
  }

  formatSnippet(snippet, options) {
    const parts = [];

    parts.push(`### ${snippet.name}`);

    if (snippet.description) {
      parts.push(`*${snippet.description}*`);
      parts.push('');
    }

    parts.push(snippet.content);
    parts.push('');

    return parts.join('\n');
  }

  assembleComponents(components, format) {
    if (format === 'json') {
      return JSON.stringify(components.map(c => ({
        type: c.type,
        content: c.content
      })), null, 2);
    }

    // Markdown format (default)
    const parts = ['---', '# Context', ''];

    for (const component of components) {
      parts.push(component.content);
    }

    parts.push('---', '');

    return parts.join('\n');
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  estimateTokens(text) {
    if (!text) return 0;
    // Rough estimate: ~4 characters per token for English text
    return Math.ceil(text.length / 4);
  }

  extractKeywords(text) {
    // Simple keyword extraction
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3); // Filter short words

    // Remove common words
    const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'what', 'when', 'where', 'how']);
    const filtered = words.filter(w => !stopWords.has(w));

    // Return unique keywords
    return [...new Set(filtered)].slice(0, 10);
  }
}

/**
 * Helper function to create and build context in one call
 */
export async function buildContext(userId, options = {}) {
  const builder = new ContextBuilder(userId);

  // Add profile (always include if minimal)
  if (options.includeProfile !== false) {
    await builder.addProfile({ minimal: options.minimalProfile || false });
  }

  // Add project if specified
  if (options.projectId) {
    await builder.addProject(options.projectId);
  }

  // Add task if specified
  if (options.taskId) {
    await builder.addTask(options.taskId, { includeProject: options.includeTaskProject || false });
  }

  // Add snippets if specified
  if (options.snippetIds && options.snippetIds.length > 0) {
    await builder.addSnippets(options.snippetIds);
  }

  // Optimize if max tokens specified
  if (options.maxTokens) {
    return await builder.optimize(options.maxTokens);
  }

  return builder.build(options.format || 'markdown');
}
