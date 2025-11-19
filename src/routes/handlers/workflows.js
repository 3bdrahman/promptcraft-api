/**
 * Workflows API Handler - Updated for Enterprise Schema
 * Uses universal entity table with entity_type = 'workflow'
 * Supports temporal versioning and event sourcing
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
import {
  db,
  ensureTenant,
  createEntity,
  updateEntity,
  deleteEntity,
  getCurrentEntity,
  trackUsage,
  logEvent
} from '../../utils/database.js';
import { success, error } from '../../utils/responses.js';
import axios from 'axios';

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
  const result = await db.query(
    `SELECT id, owner_id, visibility FROM entity
     WHERE id = $1 AND entity_type = 'workflow'
       AND valid_to IS NULL AND deleted_at IS NULL`,
    [workflowId]
  );

  if (result.rows.length === 0) {
    return { hasAccess: false, workflow: null, reason: 'Workflow not found' };
  }

  const workflow = result.rows[0];

  // User owns the workflow
  if (workflow.owner_id === userId) {
    return { hasAccess: true, workflow, reason: 'owner' };
  }

  // Workflow is public (read-only access)
  if (workflow.visibility === 'public') {
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
    const templateResult = await db.query(
      `SELECT id, title, content, metadata, owner_id, visibility
       FROM entity
       WHERE id = $1 AND entity_type = 'template'
         AND valid_to IS NULL AND deleted_at IS NULL`,
      [templateId]
    );

    if (templateResult.rows.length === 0) {
      throw new Error(`Template ${templateId} not found`);
    }

    const template = templateResult.rows[0];

    // Check access
    if (
      template.visibility === 'private' &&
      template.owner_id !== userId
    ) {
      throw new Error(`No access to template ${templateId}`);
    }

    // Extract content (stored as JSONB)
    const content = template.content?.text || (typeof template.content === 'string' ? template.content : JSON.stringify(template.content));

    // Perform variable substitution
    let rendered = content;
    const variablesUsed = [];

    // Replace {{variable}} patterns
    const variableRegex = /\{\{([^}]+)\}\}/g;
    let match;

    while ((match = variableRegex.exec(content)) !== null) {
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
      templateName: template.title,
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

    // Ensure tenant
    const tenantId = await ensureTenant(userId);

    // Create entity
    const entity = await createEntity({
      tenantId,
      ownerId: userId,
      entityType: 'workflow',
      title: name,
      description: description || '',
      content: { steps: config.steps, config }, // Store workflow config as JSONB
      tags: tags || [],
      metadata: {
        status: status || 'draft',
        category: category || 'general',
        is_public: is_public || false
      },
      visibility: (is_public || false) ? 'public' : 'private',
      status: 'published'
    });

    // Log event
    await logEvent({
      tenantId,
      eventType: 'entity.created',
      aggregateType: 'entity',
      aggregateId: entity.id,
      actorId: userId,
      payload: { entityType: 'workflow', status: status || 'draft', category: category || 'general' }
    });

    // Map to old format for compatibility
    const workflow = mapEntityToWorkflow(entity);

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
        e.*,
        COALESCE(es.usage_last_30d, 0) as total_executions
      FROM entity e
      LEFT JOIN entity_stats es ON e.id = es.entity_id
      WHERE e.entity_type = 'workflow'
        AND e.valid_to IS NULL
        AND e.deleted_at IS NULL
        AND (e.owner_id = $1 ${include_public === 'true' ? 'OR e.visibility = \'public\'' : ''})
    `;

    const params = [userId];
    let paramIndex = 2;

    if (statusFilter) {
      queryText += ` AND e.metadata->>'status' = $${paramIndex}`;
      params.push(statusFilter);
      paramIndex++;
    }

    if (category) {
      queryText += ` AND e.metadata->>'category' = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (search) {
      queryText += ` AND (e.title ILIKE $${paramIndex} OR e.description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    queryText += ` ORDER BY e.updated_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(queryText, params);

    // Get total count
    const countParams = [userId];
    let countQuery = `
      SELECT COUNT(*) as total
      FROM entity e
      WHERE e.entity_type = 'workflow'
        AND e.valid_to IS NULL
        AND e.deleted_at IS NULL
        AND e.owner_id = $1
    `;

    if (statusFilter) {
      countQuery += ` AND e.metadata->>'status' = $2`;
      countParams.push(statusFilter);
    }

    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    // Map entities to old format
    const workflows = result.rows.map(entity => mapEntityToWorkflow(entity));

    return res.json(success({
      workflows,
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

    // Get workflow entity
    const result = await db.query(
      `SELECT * FROM entity
       WHERE id = $1 AND entity_type = 'workflow'
         AND valid_to IS NULL AND deleted_at IS NULL`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Workflow not found'));
    }

    const entity = result.rows[0];
    const workflow = mapEntityToWorkflow(entity);
    const steps = entity.content?.steps || [];

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

    // Get current entity
    const current = await getCurrentEntity(id);
    if (!current || current.owner_id !== userId || current.entity_type !== 'workflow') {
      return res.status(404).json(error('Workflow not found'));
    }

    // Validate config if provided
    if (config) {
      const validation = validateWorkflowConfig(config);
      if (!validation.valid) {
        return res.status(400).json(error(`Invalid workflow config: ${validation.error}`));
      }
    }

    // Build updates object
    const updates = {};
    if (name !== undefined) updates.title = name.trim();
    if (description !== undefined) updates.description = description;
    if (config !== undefined) updates.content = { steps: config.steps, config };
    if (tags !== undefined) updates.tags = tags;

    // Update metadata
    if (status !== undefined || is_public !== undefined || category !== undefined) {
      updates.metadata = {
        ...current.metadata,
        ...(status !== undefined && { status }),
        ...(category !== undefined && { category }),
        ...(is_public !== undefined && { is_public })
      };
    }

    // Update visibility if is_public changed
    if (is_public !== undefined) {
      updates.visibility = is_public ? 'public' : 'private';
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json(error('No fields to update'));
    }

    // Update entity (creates new version)
    const updated = await updateEntity(id, updates, userId);

    // Log event
    const tenantId = await ensureTenant(userId);
    await logEvent({
      tenantId,
      eventType: 'entity.updated',
      aggregateType: 'entity',
      aggregateId: id,
      actorId: userId,
      payload: { entityType: 'workflow', fields: Object.keys(updates) }
    });

    // Map to old format
    const workflow = mapEntityToWorkflow(updated);

    return res.json(success({
      workflow,
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

    // Get current entity
    const current = await getCurrentEntity(id);
    if (!current || current.owner_id !== userId || current.entity_type !== 'workflow') {
      return res.status(404).json(error('Workflow not found or access denied'));
    }

    // Delete entity (soft delete)
    await deleteEntity(id, userId);

    // Log event
    const tenantId = await ensureTenant(userId);
    await logEvent({
      tenantId,
      eventType: 'entity.deleted',
      aggregateType: 'entity',
      aggregateId: id,
      actorId: userId,
      payload: { entityType: 'workflow', title: current.title }
    });

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

    // Get workflow entity
    const workflowResult = await db.query(
      `SELECT * FROM entity
       WHERE id = $1 AND entity_type = 'workflow'
         AND valid_to IS NULL AND deleted_at IS NULL`,
      [id]
    );

    if (workflowResult.rows.length === 0) {
      return res.status(404).json(error('Workflow not found'));
    }

    const entity = workflowResult.rows[0];
    const config = entity.content?.config || {};
    const steps = entity.content?.steps || [];

    // Generate execution ID for tracking
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    // Execute workflow steps
    const stepResults = [];
    const context = {
      workflow: {
        id: entity.id,
        name: entity.title,
        input: variables,
      },
    };

    let finalOutput = null;
    let executionStatus = 'completed';
    let errorMessage = null;
    let errorStack = null;

    try {
      for (const step of steps) {
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
        if (steps.indexOf(step) === steps.length - 1) {
          finalOutput = stepResult.output;
        }
      }
    } catch (err) {
      console.error('Workflow execution error:', err);
      executionStatus = 'failed';
      errorMessage = err.message;
      errorStack = err.stack;
    }

    // Record completion time
    const completedAt = new Date();
    const durationMs = completedAt - startTime;

    // Get tenant for event logging
    const tenantId = await ensureTenant(userId);

    // Log execution event to usage_event table
    await db.query(
      `INSERT INTO usage_event (
        tenant_id, user_id, entity_id, event_type, event_date,
        metadata, duration_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        userId,
        id,
        'workflow.executed',
        completedAt,
        JSON.stringify({
          executionId,
          status: executionStatus,
          inputVariables: variables,
          stepCount: steps.length,
          completedSteps: stepResults.filter(r => r.status === 'completed').length,
          error: errorMessage || null,
          finalOutput: finalOutput || null
        }),
        durationMs
      ]
    );

    // Track usage
    await trackUsage({
      tenantId,
      userId,
      entityId: id,
      eventType: 'workflow.executed'
    });

    // Log event
    await logEvent({
      tenantId,
      eventType: 'workflow.executed',
      aggregateType: 'entity',
      aggregateId: id,
      actorId: userId,
      payload: {
        entityType: 'workflow',
        executionId,
        status: executionStatus,
        durationMs,
        stepCount: steps.length
      }
    });

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

    // Get executions from usage_event table
    const result = await db.query(
      `SELECT
        id,
        entity_id as workflow_id,
        metadata->>'status' as status,
        event_date as started_at,
        event_date as completed_at,
        duration_ms,
        metadata->>'error' as error_message,
        metadata
      FROM usage_event
      WHERE entity_id = $1 AND event_type = 'workflow.executed'
      ORDER BY event_date DESC
      LIMIT $2 OFFSET $3`,
      [id, parseInt(limit), parseInt(offset)]
    );

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM usage_event
       WHERE entity_id = $1 AND event_type = 'workflow.executed'`,
      [id]
    );

    const total = parseInt(countResult.rows[0].total);

    // Format execution records
    const executions = result.rows.map(row => ({
      id: row.id,
      workflow_id: row.workflow_id,
      status: row.status || 'completed',
      started_at: row.started_at,
      completed_at: row.completed_at,
      duration_ms: row.duration_ms,
      error_message: row.error_message,
      metadata: row.metadata
    }));

    return res.json(success({
      executions,
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

    // Get execution from usage_event table
    const result = await db.query(
      `SELECT * FROM usage_event
       WHERE id = $1 AND entity_id = $2 AND event_type = 'workflow.executed'`,
      [executionId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(error('Execution not found'));
    }

    const row = result.rows[0];
    const execution = {
      id: row.id,
      workflow_id: row.entity_id,
      status: row.metadata?.status || 'completed',
      started_at: row.event_date,
      completed_at: row.event_date,
      duration_ms: row.duration_ms,
      metadata: row.metadata,
      input_variables: row.metadata?.inputVariables || {},
      final_output: row.metadata?.finalOutput || null,
      error_message: row.metadata?.error || null
    };

    return res.json(success({
      execution,
    }));
  } catch (err) {
    console.error('Error getting execution:', err);
    return res.status(500).json(error('Failed to get execution'));
  }
});

// ============================================================================
// Helper Function: Map entity to workflow format (backward compatibility)
// ============================================================================

function mapEntityToWorkflow(entity) {
  const metadata = entity.metadata || {};
  const content = entity.content || {};

  return {
    id: entity.id,
    name: entity.title,
    description: entity.description,
    config: content.config || { steps: content.steps || [] },
    status: metadata.status || 'draft',
    is_public: metadata.is_public || entity.visibility === 'public',
    category: metadata.category || 'general',
    tags: entity.tags || [],
    user_id: entity.owner_id,
    owner_id: entity.owner_id,
    visibility: entity.visibility,
    created_at: entity.created_at,
    updated_at: entity.updated_at,
    version: entity.version || 1
  };
}

export default router;
