/**
 * Workflows API Handler
 * Handles workflow CRUD operations and execution
 *
 * Endpoints:
 * - POST   /api/workflows              - Create new workflow
 * - GET    /api/workflows              - List user's workflows
 * - GET    /api/workflows/:id          - Get workflow details
 * - PUT    /api/workflows/:id          - Update workflow
 * - DELETE /api/workflows/:id          - Delete workflow
 * - POST   /api/workflows/:id/execute  - Execute workflow
 * - GET    /api/workflows/:id/executions - Get execution history
 * - GET    /api/workflows/:id/executions/:executionId - Get execution details
 */

import { Router } from 'express';
import { db } from '../../utils/database.js';
import { success, error } from '../../utils/responses.js';
import axios from 'axios';

const { query } = db;

const router = Router();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate workflow configuration
 */
function validateWorkflowConfig(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'Config must be an object' };
  }

  if (!config.steps || !Array.isArray(config.steps)) {
    return { valid: false, error: 'Config must include steps array' };
  }

  if (config.steps.length === 0) {
    return { valid: false, error: 'Workflow must have at least one step' };
  }

  // Validate each step
  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i];

    if (!step.id || typeof step.id !== 'string') {
      return { valid: false, error: `Step ${i + 1} must have an id` };
    }

    if (!step.type || !['template', 'condition', 'transform', 'api_call', 'delay'].includes(step.type)) {
      return { valid: false, error: `Step ${i + 1} has invalid type: ${step.type}` };
    }

    if (!step.name || typeof step.name !== 'string') {
      return { valid: false, error: `Step ${i + 1} must have a name` };
    }

    if (step.type === 'template' && !step.templateId) {
      return { valid: false, error: `Step ${i + 1} is type 'template' but missing templateId` };
    }
  }

  return { valid: true };
}

/**
 * Check if user has access to workflow
 */
async function checkWorkflowAccess(workflowId, userId) {
  const result = await query(
    `SELECT id, user_id, is_public FROM workflows WHERE id = $1`,
    [workflowId]
  );

  if (result.rows.length === 0) {
    return { hasAccess: false, workflow: null, reason: 'Workflow not found' };
  }

  const workflow = result.rows[0];

  // User owns the workflow
  if (workflow.user_id === userId) {
    return { hasAccess: true, workflow, reason: 'owner' };
  }

  // Workflow is public (read-only access)
  if (workflow.is_public) {
    return { hasAccess: true, workflow, reason: 'public', readOnly: true };
  }

  // No access
  return { hasAccess: false, workflow: null, reason: 'No access to this workflow' };
}

/**
 * Render template with variables (internal helper)
 */
async function renderTemplate(templateId, variables, userId) {
  try {
    // Get template
    const templateResult = await query(
      `SELECT id, name, content, variables as template_variables, user_id, visibility
       FROM templates
       WHERE id = $1`,
      [templateId]
    );

    if (templateResult.rows.length === 0) {
      throw new Error(`Template ${templateId} not found`);
    }

    const template = templateResult.rows[0];

    // Check access
    if (
      template.visibility === 'private' &&
      template.user_id !== userId
    ) {
      throw new Error(`No access to template ${templateId}`);
    }

    // Perform variable substitution
    let rendered = template.content;
    const variablesUsed = [];

    // Replace {{variable}} patterns
    const variableRegex = /\{\{([^}]+)\}\}/g;
    let match;

    while ((match = variableRegex.exec(template.content)) !== null) {
      const fullMatch = match[0]; // {{varName}}
      const varDef = match[1].trim(); // varName or varName:type or varName:type:description
      const varParts = varDef.split(':');
      const varName = varParts[0].trim();

      variablesUsed.push(varName);

      if (variables[varName] !== undefined) {
        rendered = rendered.replace(fullMatch, variables[varName]);
      }
    }

    return {
      rendered,
      templateId: template.id,
      templateName: template.name,
      variablesUsed: [...new Set(variablesUsed)],
    };
  } catch (err) {
    throw new Error(`Template rendering failed: ${err.message}`);
  }
}

/**
 * Execute a single workflow step
 */
async function executeStep(step, context, userId) {
  const startTime = Date.now();

  try {
    let output;
    let metadata = {};

    switch (step.type) {
      case 'template':
        // Resolve variables from context
        const resolvedVariables = {};

        if (step.variables) {
          for (const [key, value] of Object.entries(step.variables)) {
            // Replace context references like {{step1.output}} or {{workflow.input.topic}}
            if (typeof value === 'string' && value.includes('{{')) {
              resolvedVariables[key] = resolveContextVariable(value, context);
            } else {
              resolvedVariables[key] = value;
            }
          }
        }

        // Render template
        const renderResult = await renderTemplate(step.templateId, resolvedVariables, userId);
        output = renderResult.rendered;
        metadata = {
          templateId: renderResult.templateId,
          templateName: renderResult.templateName,
          variablesUsed: renderResult.variablesUsed,
          renderedLength: output.length,
        };
        break;

      case 'transform':
        // Apply transformation function
        if (step.transform && typeof step.transform === 'function') {
          output = step.transform(context);
        } else if (step.transformExpression) {
          // Eval is dangerous, but for demo purposes
          // In production, use a safe expression evaluator like expr-eval
          output = eval(step.transformExpression);
        } else {
          output = context;
        }
        break;

      case 'condition':
        // Evaluate condition
        const conditionResult = evaluateCondition(step.condition, context);
        output = conditionResult;
        metadata = { conditionMet: conditionResult };
        break;

      case 'api_call':
        // Make external API call
        const apiResponse = await axios({
          method: step.method || 'POST',
          url: step.url,
          headers: step.headers || {},
          data: step.body || {},
          timeout: step.timeout || 30000,
        });
        output = apiResponse.data;
        metadata = {
          statusCode: apiResponse.status,
          headers: apiResponse.headers,
        };
        break;

      case 'delay':
        // Wait for specified duration
        const delayMs = step.duration || 1000;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        output = context;
        metadata = { delayMs };
        break;

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }

    const duration = Date.now() - startTime;

    return {
      stepId: step.id,
      status: 'completed',
      output,
      metadata,
      duration,
      error: null,
    };
  } catch (err) {
    const duration = Date.now() - startTime;

    return {
      stepId: step.id,
      status: 'failed',
      output: null,
      metadata: {},
      duration,
      error: {
        message: err.message,
        stack: err.stack,
      },
    };
  }
}

/**
 * Resolve context variables like {{step1.output}} or {{workflow.input.topic}}
 */
function resolveContextVariable(template, context) {
  let resolved = template;

  const regex = /\{\{([^}]+)\}\}/g;
  let match;

  while ((match = regex.exec(template)) !== null) {
    const fullMatch = match[0]; // {{step1.output}}
    const path = match[1].trim(); // step1.output
    const value = getNestedValue(context, path);

    if (value !== undefined) {
      resolved = resolved.replace(fullMatch, value);
    }
  }

  return resolved;
}

/**
 * Get nested object value by path (e.g., "step1.output" from context)
 */
function getNestedValue(obj, path) {
  const parts = path.split('.');
  let current = obj;

  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Evaluate condition expression
 */
function evaluateCondition(condition, context) {
  // Simple condition evaluator
  // In production, use a safe expression evaluator
  try {
    // Allow access to context in condition
    const func = new Function('context', `return ${condition}`);
    return func(context);
  } catch (err) {
    console.error('Condition evaluation error:', err);
    return false;
  }
}

// ============================================================================
// API Endpoints
// ============================================================================

/**
 * POST /api/workflows
 * Create a new workflow
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, description, config, status, is_public, category, tags } = req.body;

    // Validation
    if (!name || name.trim().length === 0) {
      return res.status(400).json(error('Workflow name is required'));
    }

    if (!config) {
      return res.status(400).json(error('Workflow config is required'));
    }

    // Validate config structure
    const validation = validateWorkflowConfig(config);
    if (!validation.valid) {
      return res.status(400).json(error(`Invalid workflow config: ${validation.error}`));
    }

    // Insert workflow
    const result = await query(
      `INSERT INTO workflows (
        user_id, name, description, config, status, is_public, category, tags
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        userId,
        name.trim(),
        description || null,
        JSON.stringify(config),
        status || 'draft',
        is_public || false,
        category || 'general',
        tags || [],
      ]
    );

    const workflow = result.rows[0];

    return res.status(201).json(success({
      workflow,
      message: 'Workflow created successfully',
    }));
  } catch (err) {
    console.error('Error creating workflow:', err);
    return res.status(500).json(error('Failed to create workflow'));
  }
});

/**
 * GET /api/workflows
 * List user's workflows
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      status: statusFilter,
      category,
      search,
      limit = 50,
      offset = 0,
      include_public = 'false',
    } = req.query;

    let queryText = `
      SELECT
        w.*,
        (
          SELECT COUNT(*)::INTEGER
          FROM workflow_executions we
          WHERE we.workflow_id = w.id
        ) as total_executions,
        (
          SELECT json_agg(
            json_build_object(
              'id', we.id,
              'status', we.status,
              'started_at', we.started_at,
              'completed_at', we.completed_at,
              'duration_ms', we.duration_ms
            )
            ORDER BY we.created_at DESC
          )
          FROM (
            SELECT *
            FROM workflow_executions we2
            WHERE we2.workflow_id = w.id
            ORDER BY we2.created_at DESC
            LIMIT 5
          ) we
        ) as recent_executions
      FROM workflows w
      WHERE (w.user_id = $1 ${include_public === 'true' ? 'OR w.is_public = true' : ''})
    `;

    const params = [userId];
    let paramIndex = 2;

    if (statusFilter) {
      queryText += ` AND w.status = $${paramIndex}`;
      params.push(statusFilter);
      paramIndex++;
    }

    if (category) {
      queryText += ` AND w.category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (search) {
      queryText += ` AND (w.name ILIKE $${paramIndex} OR w.description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    queryText += ` ORDER BY w.updated_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(queryText, params);

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) as total
       FROM workflows w
       WHERE w.user_id = $1 ${statusFilter ? 'AND w.status = $2' : ''}`,
      statusFilter ? [userId, statusFilter] : [userId]
    );

    const total = parseInt(countResult.rows[0].total);

    return res.json(success({
      workflows: result.rows,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: offset + result.rows.length < total,
      },
    }));
  } catch (err) {
    console.error('Error listing workflows:', err);
    return res.status(500).json(error('Failed to list workflows'));
  }
});

/**
 * GET /api/workflows/:id
 * Get workflow details
 */
router.get('/:id', async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    // Check access
    const accessCheck = await checkWorkflowAccess(id, userId);
    if (!accessCheck.hasAccess) {
      return res.status(accessCheck.workflow ? 403 : 404).json(
        error(accessCheck.reason)
      );
    }

    // Get workflow with steps
    const result = await query(
      `SELECT * FROM get_workflow_with_steps($1)`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Workflow not found'));
    }

    const { workflow, steps } = result.rows[0];

    return res.json(success({
      workflow,
      steps,
      readOnly: accessCheck.readOnly || false,
    }));
  } catch (err) {
    console.error('Error getting workflow:', err);
    return res.status(500).json(error('Failed to get workflow'));
  }
});

/**
 * PUT /api/workflows/:id
 * Update workflow
 */
router.put('/:id', async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { name, description, config, status, is_public, category, tags } = req.body;

    // Check access
    const accessCheck = await checkWorkflowAccess(id, userId);
    if (!accessCheck.hasAccess) {
      return res.status(accessCheck.workflow ? 403 : 404).json(
        error(accessCheck.reason)
      );
    }

    if (accessCheck.readOnly) {
      return res.status(403).json(error('Cannot edit public workflows you don\'t own'));
    }

    // Validate config if provided
    if (config) {
      const validation = validateWorkflowConfig(config);
      if (!validation.valid) {
        return res.status(400).json(error(`Invalid workflow config: ${validation.error}`));
      }
    }

    // Build update query dynamically
    const updates = [];
    const values = [id];
    let paramIndex = 2;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      values.push(name.trim());
      paramIndex++;
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      values.push(description);
      paramIndex++;
    }

    if (config !== undefined) {
      updates.push(`config = $${paramIndex}`);
      values.push(JSON.stringify(config));
      paramIndex++;
    }

    if (status !== undefined) {
      updates.push(`status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }

    if (is_public !== undefined) {
      updates.push(`is_public = $${paramIndex}`);
      values.push(is_public);
      paramIndex++;
    }

    if (category !== undefined) {
      updates.push(`category = $${paramIndex}`);
      values.push(category);
      paramIndex++;
    }

    if (tags !== undefined) {
      updates.push(`tags = $${paramIndex}`);
      values.push(tags);
      paramIndex++;
    }

    if (updates.length === 0) {
      return res.status(400).json(error('No fields to update'));
    }

    const result = await query(
      `UPDATE workflows
       SET ${updates.join(', ')}
       WHERE id = $1 AND user_id = $${paramIndex}
       RETURNING *`,
      [...values, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Workflow not found or access denied'));
    }

    return res.json(success({
      workflow: result.rows[0],
      message: 'Workflow updated successfully',
    }));
  } catch (err) {
    console.error('Error updating workflow:', err);
    return res.status(500).json(error('Failed to update workflow'));
  }
});

/**
 * DELETE /api/workflows/:id
 * Delete workflow
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    // Check access
    const accessCheck = await checkWorkflowAccess(id, userId);
    if (!accessCheck.hasAccess) {
      return res.status(accessCheck.workflow ? 403 : 404).json(
        error(accessCheck.reason)
      );
    }

    if (accessCheck.readOnly) {
      return res.status(403).json(error('Cannot delete workflows you don\'t own'));
    }

    // Delete workflow (cascade will delete steps and executions)
    const result = await query(
      `DELETE FROM workflows
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Workflow not found or access denied'));
    }

    return res.json(success({
      message: 'Workflow deleted successfully',
      workflowId: id,
    }));
  } catch (err) {
    console.error('Error deleting workflow:', err);
    return res.status(500).json(error('Failed to delete workflow'));
  }
});

/**
 * POST /api/workflows/:id/execute
 * Execute workflow with provided input variables
 */
router.post('/:id/execute', async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { variables = {} } = req.body;

    // Check access
    const accessCheck = await checkWorkflowAccess(id, userId);
    if (!accessCheck.hasAccess) {
      return res.status(accessCheck.workflow ? 403 : 404).json(
        error(accessCheck.reason)
      );
    }

    // Get workflow
    const workflowResult = await query(
      `SELECT * FROM workflows WHERE id = $1`,
      [id]
    );

    if (workflowResult.rows.length === 0) {
      return res.status(404).json(error('Workflow not found'));
    }

    const workflow = workflowResult.rows[0];
    const config = workflow.config;

    // Create execution record
    const executionResult = await query(
      `INSERT INTO workflow_executions (
        workflow_id, user_id, input_variables, status
      ) VALUES ($1, $2, $3, $4)
      RETURNING *`,
      [id, userId, JSON.stringify(variables), 'running']
    );

    const execution = executionResult.rows[0];
    const executionId = execution.id;

    // Execute workflow steps
    const stepResults = [];
    const context = {
      workflow: {
        id: workflow.id,
        name: workflow.name,
        input: variables,
      },
    };

    let finalOutput = null;
    let executionStatus = 'completed';
    let errorMessage = null;
    let errorStack = null;

    try {
      for (const step of config.steps) {
        console.log(`Executing step: ${step.id} (${step.type})`);

        const stepResult = await executeStep(step, context, userId);
        stepResults.push(stepResult);

        // Add step output to context for next steps
        context[step.id] = {
          output: stepResult.output,
          metadata: stepResult.metadata,
          status: stepResult.status,
        };

        // Handle step failure
        if (stepResult.status === 'failed') {
          const onError = step.onError || 'fail';

          if (onError === 'fail') {
            executionStatus = 'failed';
            errorMessage = `Step ${step.id} failed: ${stepResult.error.message}`;
            errorStack = stepResult.error.stack;
            break;
          } else if (onError === 'continue') {
            console.log(`Step ${step.id} failed but continuing due to onError=continue`);
            continue;
          } else if (onError === 'retry') {
            // TODO: Implement retry logic
            console.log(`Step ${step.id} failed, retry not yet implemented`);
            continue;
          }
        }

        // Check if this is the last step
        if (config.steps.indexOf(step) === config.steps.length - 1) {
          finalOutput = stepResult.output;
        }
      }
    } catch (err) {
      console.error('Workflow execution error:', err);
      executionStatus = 'failed';
      errorMessage = err.message;
      errorStack = err.stack;
    }

    // Update execution record
    const completedAt = new Date();
    const durationMs = completedAt - new Date(execution.started_at);

    await query(
      `UPDATE workflow_executions
       SET
         status = $1,
         results = $2,
         final_output = $3,
         error_message = $4,
         error_stack = $5,
         completed_at = $6,
         duration_ms = $7
       WHERE id = $8`,
      [
        executionStatus,
        JSON.stringify({ steps: stepResults }),
        finalOutput,
        errorMessage,
        errorStack,
        completedAt,
        durationMs,
        executionId,
      ]
    );

    return res.json(success({
      executionId,
      status: executionStatus,
      finalOutput,
      stepResults,
      durationMs,
      error: errorMessage ? { message: errorMessage, stack: errorStack } : null,
    }));
  } catch (err) {
    console.error('Error executing workflow:', err);
    return res.status(500).json(error('Failed to execute workflow'));
  }
});

/**
 * GET /api/workflows/:id/executions
 * Get workflow execution history
 */
router.get('/:id/executions', async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Check access
    const accessCheck = await checkWorkflowAccess(id, userId);
    if (!accessCheck.hasAccess) {
      return res.status(accessCheck.workflow ? 403 : 404).json(
        error(accessCheck.reason)
      );
    }

    // Get executions
    const result = await query(
      `SELECT
        id,
        workflow_id,
        status,
        started_at,
        completed_at,
        duration_ms,
        error_message
      FROM workflow_executions
      WHERE workflow_id = $1
      ORDER BY started_at DESC
      LIMIT $2 OFFSET $3`,
      [id, parseInt(limit), parseInt(offset)]
    );

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) as total FROM workflow_executions WHERE workflow_id = $1`,
      [id]
    );

    const total = parseInt(countResult.rows[0].total);

    return res.json(success({
      executions: result.rows,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: offset + result.rows.length < total,
      },
    }));
  } catch (err) {
    console.error('Error getting executions:', err);
    return res.status(500).json(error('Failed to get executions'));
  }
});

/**
 * GET /api/workflows/:id/executions/:executionId
 * Get detailed execution results
 */
router.get('/:id/executions/:executionId', async (req, res) => {
  try {
    const userId = req.user.id;
    const { id, executionId } = req.params;

    // Check access to workflow
    const accessCheck = await checkWorkflowAccess(id, userId);
    if (!accessCheck.hasAccess) {
      return res.status(accessCheck.workflow ? 403 : 404).json(
        error(accessCheck.reason)
      );
    }

    // Get execution
    const result = await query(
      `SELECT * FROM workflow_executions
       WHERE id = $1 AND workflow_id = $2`,
      [executionId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Execution not found'));
    }

    return res.json(success({
      execution: result.rows[0],
    }));
  } catch (err) {
    console.error('Error getting execution:', err);
    return res.status(500).json(error('Failed to get execution'));
  }
});

export default router;
