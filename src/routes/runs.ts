import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const runs = new Hono<{ Bindings: Bindings }>()

// GET /api/projects/:projectId/runs - Get all runs for a project
runs.get('/projects/:projectId/runs', async (c) => {
  try {
    const projectId = c.req.param('projectId')

    const { results } = await c.env.DB.prepare(`
      SELECT id, project_id, run_no, state, source_type, source_text, title, 
             parse_status, format_status, generate_status,
             created_at, updated_at
      FROM runs
      WHERE project_id = ?
      ORDER BY run_no ASC
    `).bind(projectId).all()

    return c.json({
      project_id: parseInt(projectId),
      runs: results
    })
  } catch (error) {
    console.error('Get runs error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get runs'
      }
    }, 500)
  }
})

// POST /api/projects/:projectId/runs - Create a new run
runs.post('/projects/:projectId/runs', async (c) => {
  try {
    const projectId = c.req.param('projectId')

    // Get max run_no for this project
    const maxRunNo = await c.env.DB.prepare(`
      SELECT COALESCE(MAX(run_no), 0) as max_run_no
      FROM runs
      WHERE project_id = ?
    `).bind(projectId).first()

    const newRunNo = (maxRunNo?.max_run_no as number || 0) + 1

    // Create new run
    const result = await c.env.DB.prepare(`
      INSERT INTO runs (project_id, run_no, state, title, source_type)
      VALUES (?, ?, 'draft', ?, 'text')
    `).bind(projectId, newRunNo, `Run #${newRunNo}`).run()

    const newRunId = result.meta.last_row_id as number

    // Fetch created run
    const newRun = await c.env.DB.prepare(`
      SELECT id, project_id, run_no, state, source_type, title, 
             parse_status, format_status, generate_status,
             created_at, updated_at
      FROM runs
      WHERE id = ?
    `).bind(newRunId).first()

    return c.json(newRun, 201)
  } catch (error) {
    console.error('Create run error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create run'
      }
    }, 500)
  }
})

// GET /api/runs/:runId - Get a single run
runs.get('/runs/:runId', async (c) => {
  try {
    const runId = c.req.param('runId')

    const run = await c.env.DB.prepare(`
      SELECT id, project_id, run_no, state, source_type, source_text, title,
             parse_status, format_status, generate_status,
             created_at, updated_at
      FROM runs
      WHERE id = ?
    `).bind(runId).first()

    if (!run) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Run not found'
        }
      }, 404)
    }

    return c.json(run)
  } catch (error) {
    console.error('Get run error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get run'
      }
    }, 500)
  }
})

// POST /api/runs/:runId/approve - Approve a run (change state to 'approved')
runs.post('/runs/:runId/approve', async (c) => {
  try {
    const runId = c.req.param('runId')

    // Get current run state
    const run = await c.env.DB.prepare(`
      SELECT id, state FROM runs WHERE id = ?
    `).bind(runId).first()

    if (!run) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Run not found'
        }
      }, 404)
    }

    // Idempotent: Already approved
    if (run.state === 'approved') {
      return c.json({
        run_id: parseInt(runId),
        state: 'approved',
        message: 'Run already approved'
      })
    }

    // Update state to 'approved'
    await c.env.DB.prepare(`
      UPDATE runs
      SET state = 'approved', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(runId).run()

    return c.json({
      run_id: parseInt(runId),
      state: 'approved'
    })
  } catch (error) {
    console.error('Approve run error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to approve run'
      }
    }, 500)
  }
})

// POST /api/runs/:runId/fork - Fork an approved run to create a new draft
runs.post('/runs/:runId/fork', async (c) => {
  try {
    const runId = c.req.param('runId')

    // Get source run
    const sourceRun = await c.env.DB.prepare(`
      SELECT id, project_id, run_no, state, source_type, source_text, title
      FROM runs
      WHERE id = ?
    `).bind(runId).first()

    if (!sourceRun) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Run not found'
        }
      }, 404)
    }

    // Can only fork approved runs
    if (sourceRun.state !== 'approved') {
      return c.json({
        error: {
          code: 'INVALID_STATE',
          message: 'Can only fork approved runs',
          details: {
            current_state: sourceRun.state,
            required_state: 'approved'
          }
        }
      }, 400)
    }

    // Get max run_no for this project
    const maxRunNo = await c.env.DB.prepare(`
      SELECT COALESCE(MAX(run_no), 0) as max_run_no
      FROM runs
      WHERE project_id = ?
    `).bind(sourceRun.project_id).first()

    const newRunNo = (maxRunNo?.max_run_no as number || 0) + 1

    // Create new draft run
    const result = await c.env.DB.prepare(`
      INSERT INTO runs (project_id, run_no, state, source_type, source_text, title)
      VALUES (?, ?, 'draft', ?, ?, ?)
    `).bind(
      sourceRun.project_id,
      newRunNo,
      sourceRun.source_type,
      sourceRun.source_text,
      `${sourceRun.title} (fork)`
    ).run()

    const newRunId = result.meta.last_row_id as number

    // Fetch created run
    const newRun = await c.env.DB.prepare(`
      SELECT id, project_id, run_no, state, source_type, source_text, title,
             created_at, updated_at
      FROM runs
      WHERE id = ?
    `).bind(newRunId).first()

    return c.json({
      from_run_id: parseInt(runId),
      new_run_id: newRunId,
      run_no: newRunNo,
      state: 'draft',
      title: newRun?.title
    }, 201)
  } catch (error) {
    console.error('Fork run error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fork run'
      }
    }, 500)
  }
})

export default runs
