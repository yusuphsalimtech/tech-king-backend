import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, HttpError } from '../utils/helpers';

export const automationsRouter = Router();
automationsRouter.use(requireAuth);

automationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query<any>(
      `SELECT a.*, s.name AS session_name FROM automations a
       LEFT JOIN sessions s ON s.id = a.session_id
       WHERE a.user_id = $1 ORDER BY a.created_at DESC`,
      [req.user!.id]
    );
    res.json({ automations: rows });
  })
);

const createSchema = z.object({
  sessionId: z.string().uuid(),
  name: z.string().min(1).max(80),
  triggerType: z.enum(['interval', 'keyword']),
  triggerConfig: z.record(z.unknown()).default({}),
  actionType: z.enum(['send_message']).default('send_message'),
  actionConfig: z.record(z.unknown()).default({}),
});

function defaultNextRun(triggerType: string, triggerConfig: Record<string, unknown>): Date | null {
  if (triggerType !== 'interval') return null;
  const minutes = Math.max(1, Number(triggerConfig.minutes) || 60);
  return new Date(Date.now() + minutes * 60_000);
}

automationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const session = await queryOne<{ user_id: number }>(`SELECT user_id FROM sessions WHERE id = $1`, [body.sessionId]);
    if (!session) throw new HttpError(404, 'Session not found');
    if (session.user_id !== req.user!.id) throw new HttpError(403, 'This session belongs to another account');

    const nextRun = defaultNextRun(body.triggerType, body.triggerConfig);
    const row = await queryOne<any>(
      `INSERT INTO automations (user_id, session_id, name, trigger_type, trigger_config, action_type, action_config, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user!.id, body.sessionId, body.name, body.triggerType, JSON.stringify(body.triggerConfig), body.actionType, JSON.stringify(body.actionConfig), nextRun]
    );
    res.status(201).json({ automation: row });
  })
);

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  triggerConfig: z.record(z.unknown()).optional(),
  actionConfig: z.record(z.unknown()).optional(),
});

automationsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (body.name !== undefined) { sets.push(`name = $${idx++}`); values.push(body.name); }
    if (body.enabled !== undefined) { sets.push(`enabled = $${idx++}`); values.push(body.enabled); }
    if (body.triggerConfig !== undefined) { sets.push(`trigger_config = $${idx++}`); values.push(JSON.stringify(body.triggerConfig)); }
    if (body.actionConfig !== undefined) { sets.push(`action_config = $${idx++}`); values.push(JSON.stringify(body.actionConfig)); }
    if (sets.length === 0) throw new HttpError(400, 'Nothing to update');
    values.push(req.params.id, req.user!.id);
    const row = await queryOne<any>(
      `UPDATE automations SET ${sets.join(', ')}, updated_at = now() WHERE id = $${idx} AND user_id = $${idx + 1} RETURNING *`,
      values
    );
    if (!row) throw new HttpError(404, 'Automation not found');
    res.json({ automation: row });
  })
);

automationsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await queryOne<any>(
      `DELETE FROM automations WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user!.id]
    );
    if (!row) throw new HttpError(404, 'Automation not found');
    res.json({ ok: true });
  })
);
