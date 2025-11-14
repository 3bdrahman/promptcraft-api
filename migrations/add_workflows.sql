/**
 * Database Migration: Workflows Feature
 * Description: Adds tables and functions for workflow orchestration
 * Date: November 14, 2025
 *
 * Features:
 * - Create and manage multi-step workflows
 * - Execute workflows with template chaining
 * - Track execution history and results
 * - Support conditional logic and branching
 */

-- ============================================================================
-- TABLE: workflows
-- Description: Stores workflow definitions
-- ============================================================================
CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,

  -- Workflow configuration stored as JSONB for flexibility
  -- Structure: { steps: [...], variables: {...}, settings: {...} }
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Status: draft, active, archived
  status VARCHAR(50) DEFAULT 'draft',

  -- Metadata
  is_public BOOLEAN DEFAULT false,
  category VARCHAR(100) DEFAULT 'general',
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_executed_at TIMESTAMP WITH TIME ZONE,

  -- Statistics
  execution_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,

  -- Constraints
  CONSTRAINT workflows_name_length CHECK (char_length(name) >= 1 AND char_length(name) <= 255),
  CONSTRAINT workflows_status_valid CHECK (status IN ('draft', 'active', 'archived'))
);

-- Indexes for performance
CREATE INDEX idx_workflows_user_id ON workflows(user_id);
CREATE INDEX idx_workflows_status ON workflows(status);
CREATE INDEX idx_workflows_category ON workflows(category);
CREATE INDEX idx_workflows_created_at ON workflows(created_at DESC);
CREATE INDEX idx_workflows_tags ON workflows USING GIN(tags);
CREATE INDEX idx_workflows_config ON workflows USING GIN(config);

-- ============================================================================
-- TABLE: workflow_executions
-- Description: Tracks workflow execution history
-- ============================================================================
CREATE TABLE IF NOT EXISTS workflow_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Input variables provided for this execution
  input_variables JSONB DEFAULT '{}'::jsonb,

  -- Execution results for each step
  -- Structure: { steps: [{ stepId, status, output, error, duration }] }
  results JSONB DEFAULT '{}'::jsonb,

  -- Final output
  final_output TEXT,

  -- Status: running, completed, failed, cancelled
  status VARCHAR(50) DEFAULT 'running',

  -- Error information if failed
  error_message TEXT,
  error_stack TEXT,

  -- Performance metrics
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  duration_ms INTEGER,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Constraints
  CONSTRAINT workflow_executions_status_valid CHECK (status IN ('running', 'completed', 'failed', 'cancelled'))
);

-- Indexes for performance
CREATE INDEX idx_workflow_executions_workflow_id ON workflow_executions(workflow_id);
CREATE INDEX idx_workflow_executions_user_id ON workflow_executions(user_id);
CREATE INDEX idx_workflow_executions_status ON workflow_executions(status);
CREATE INDEX idx_workflow_executions_created_at ON workflow_executions(created_at DESC);
CREATE INDEX idx_workflow_executions_results ON workflow_executions USING GIN(results);

-- ============================================================================
-- TABLE: workflow_steps
-- Description: Individual steps within workflows (optional normalized storage)
-- ============================================================================
CREATE TABLE IF NOT EXISTS workflow_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,

  -- Step definition
  step_order INTEGER NOT NULL,
  step_type VARCHAR(50) NOT NULL, -- 'template', 'condition', 'transform', 'api_call'
  step_name VARCHAR(255) NOT NULL,

  -- Step configuration stored as JSONB
  -- Structure varies by step_type
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Template reference if step_type = 'template'
  template_id UUID REFERENCES templates(id) ON DELETE SET NULL,

  -- Conditional logic
  condition_expression TEXT, -- e.g., "output.length > 100"

  -- Error handling
  on_error VARCHAR(50) DEFAULT 'fail', -- 'fail', 'continue', 'retry'
  max_retries INTEGER DEFAULT 0,
  retry_delay_ms INTEGER DEFAULT 1000,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Constraints
  CONSTRAINT workflow_steps_step_order_positive CHECK (step_order > 0),
  CONSTRAINT workflow_steps_step_type_valid CHECK (step_type IN ('template', 'condition', 'transform', 'api_call', 'delay')),
  CONSTRAINT workflow_steps_on_error_valid CHECK (on_error IN ('fail', 'continue', 'retry')),
  CONSTRAINT workflow_steps_unique_order UNIQUE (workflow_id, step_order)
);

-- Indexes for performance
CREATE INDEX idx_workflow_steps_workflow_id ON workflow_steps(workflow_id);
CREATE INDEX idx_workflow_steps_template_id ON workflow_steps(template_id);
CREATE INDEX idx_workflow_steps_step_order ON workflow_steps(workflow_id, step_order);

-- ============================================================================
-- FUNCTION: update_workflow_updated_at
-- Description: Automatically update updated_at timestamp
-- ============================================================================
CREATE OR REPLACE FUNCTION update_workflow_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for workflows table
CREATE TRIGGER trigger_workflows_updated_at
  BEFORE UPDATE ON workflows
  FOR EACH ROW
  EXECUTE FUNCTION update_workflow_updated_at();

-- Trigger for workflow_steps table
CREATE TRIGGER trigger_workflow_steps_updated_at
  BEFORE UPDATE ON workflow_steps
  FOR EACH ROW
  EXECUTE FUNCTION update_workflow_updated_at();

-- ============================================================================
-- FUNCTION: update_workflow_stats
-- Description: Update workflow statistics after execution
-- ============================================================================
CREATE OR REPLACE FUNCTION update_workflow_stats()
RETURNS TRIGGER AS $$
BEGIN
  -- Only update when execution status changes to completed or failed
  IF NEW.status IN ('completed', 'failed') AND OLD.status = 'running' THEN
    UPDATE workflows
    SET
      execution_count = execution_count + 1,
      success_count = CASE WHEN NEW.status = 'completed' THEN success_count + 1 ELSE success_count END,
      failure_count = CASE WHEN NEW.status = 'failed' THEN failure_count + 1 ELSE failure_count END,
      last_executed_at = NEW.completed_at
    WHERE id = NEW.workflow_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for workflow_executions table
CREATE TRIGGER trigger_update_workflow_stats
  AFTER UPDATE ON workflow_executions
  FOR EACH ROW
  EXECUTE FUNCTION update_workflow_stats();

-- ============================================================================
-- FUNCTION: get_workflow_with_steps
-- Description: Get workflow with all its steps in order
-- ============================================================================
CREATE OR REPLACE FUNCTION get_workflow_with_steps(workflow_uuid UUID)
RETURNS TABLE (
  workflow JSONB,
  steps JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    to_jsonb(w.*) AS workflow,
    COALESCE(
      jsonb_agg(
        to_jsonb(ws.*) ORDER BY ws.step_order
      ) FILTER (WHERE ws.id IS NOT NULL),
      '[]'::jsonb
    ) AS steps
  FROM workflows w
  LEFT JOIN workflow_steps ws ON ws.workflow_id = w.id
  WHERE w.id = workflow_uuid
  GROUP BY w.id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: get_workflow_execution_history
-- Description: Get recent executions for a workflow
-- ============================================================================
CREATE OR REPLACE FUNCTION get_workflow_execution_history(
  workflow_uuid UUID,
  limit_count INTEGER DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  status VARCHAR,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  duration_ms INTEGER,
  success_rate NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    we.id,
    we.status,
    we.started_at,
    we.completed_at,
    we.duration_ms,
    CASE
      WHEN w.execution_count > 0
      THEN ROUND((w.success_count::NUMERIC / w.execution_count::NUMERIC) * 100, 2)
      ELSE 0
    END AS success_rate
  FROM workflow_executions we
  JOIN workflows w ON w.id = we.workflow_id
  WHERE we.workflow_id = workflow_uuid
  ORDER BY we.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SAMPLE DATA (for development/testing)
-- ============================================================================
-- Uncomment to insert sample data:

/*
-- Sample workflow: Blog Post Generator
INSERT INTO workflows (
  user_id,
  name,
  description,
  config,
  status,
  is_public,
  category,
  tags
) VALUES (
  (SELECT id FROM users LIMIT 1), -- Replace with actual user ID
  'Blog Post Generator',
  'Generate a complete blog post with title, outline, and content',
  '{
    "steps": [
      {
        "id": "step1",
        "type": "template",
        "name": "Generate Title",
        "templateId": "template-uuid-1",
        "variables": {
          "topic": "{{workflow.input.topic}}",
          "tone": "{{workflow.input.tone}}"
        }
      },
      {
        "id": "step2",
        "type": "template",
        "name": "Generate Outline",
        "templateId": "template-uuid-2",
        "variables": {
          "title": "{{step1.output}}",
          "sections": 5
        }
      },
      {
        "id": "step3",
        "type": "template",
        "name": "Write Content",
        "templateId": "template-uuid-3",
        "variables": {
          "outline": "{{step2.output}}",
          "wordCount": 1000
        }
      }
    ],
    "variables": [
      {"name": "topic", "type": "string", "required": true},
      {"name": "tone", "type": "string", "default": "professional"}
    ]
  }'::jsonb,
  'active',
  true,
  'content-creation',
  ARRAY['blog', 'writing', 'content']
);
*/

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Check tables created
SELECT 'Workflows table created' AS status
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflows');

SELECT 'Workflow executions table created' AS status
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflow_executions');

SELECT 'Workflow steps table created' AS status
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflow_steps');

-- Check indexes
SELECT schemaname, tablename, indexname
FROM pg_indexes
WHERE tablename IN ('workflows', 'workflow_executions', 'workflow_steps')
ORDER BY tablename, indexname;

-- Check functions
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_name LIKE '%workflow%'
ORDER BY routine_name;

-- ============================================================================
-- ROLLBACK SCRIPT (use if migration needs to be reversed)
-- ============================================================================

/*
-- Drop triggers
DROP TRIGGER IF EXISTS trigger_workflows_updated_at ON workflows;
DROP TRIGGER IF EXISTS trigger_workflow_steps_updated_at ON workflow_steps;
DROP TRIGGER IF EXISTS trigger_update_workflow_stats ON workflow_executions;

-- Drop functions
DROP FUNCTION IF EXISTS update_workflow_updated_at();
DROP FUNCTION IF EXISTS update_workflow_stats();
DROP FUNCTION IF EXISTS get_workflow_with_steps(UUID);
DROP FUNCTION IF EXISTS get_workflow_execution_history(UUID, INTEGER);

-- Drop tables (in reverse order due to foreign keys)
DROP TABLE IF EXISTS workflow_steps CASCADE;
DROP TABLE IF EXISTS workflow_executions CASCADE;
DROP TABLE IF EXISTS workflows CASCADE;
*/

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
SELECT 'Workflows migration completed successfully!' AS status;
