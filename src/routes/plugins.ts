import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, HttpError } from '../utils/helpers';
import { listAvailablePluginsFromDb } from '../services/pluginEngine';

export const pluginsRouter = Router();
pluginsRouter.use(requireAuth);

pluginsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const plugins = await listAvailablePluginsFromDb();
    res.json({ plugins });
  })
);

async function sessionPlugins(userId: number, sessionId: string): Promise<Record<string, any>> {
  const row = await queryOne<{ user_id: number; plugins: Record<string, any> }>(
    `SELECT user_id, plugins FROM sessions WHERE id = $1`,
    [sessionId]
  );
  if (!row) throw new HttpError(404, 'Session not found');
  if (row.user_id !== userId) throw new HttpError(403, 'This session belongs to another account');
  return row.plugins ?? {};
}

pluginsRouter.post(
  '/:pluginId/enable',
  asyncHandler(async (req, res) => {
    const plugins = await sessionPlugins(req.user!.id, req.body.sessionId as string);
    const cfg = plugins[req.params.pluginId] ?? { enabled: false, config: {} };
    plugins[req.params.pluginId] = { ...cfg, enabled: true };
    await query(`UPDATE sessions SET plugins = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(plugins), req.body.sessionId]);
    res.json({ ok: true });
  })
);

pluginsRouter.post(
  '/:pluginId/disable',
  asyncHandler(async (req, res) => {
    const plugins = await sessionPlugins(req.user!.id, req.body.sessionId as string);
    if (plugins[req.params.pluginId]) {
      plugins[req.params.pluginId].enabled = false;
    }
    await query(`UPDATE sessions SET plugins = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(plugins), req.body.sessionId]);
    res.json({ ok: true });
  })
);

const configSchema = z.object({
  sessionId: z.string().uuid(),
  config: z.record(z.unknown()),
});

pluginsRouter.patch(
  '/:pluginId',
  asyncHandler(async (req, res) => {
    const body = configSchema.parse(req.body);
    const plugins = await sessionPlugins(req.user!.id, body.sessionId);
    const cfg = plugins[req.params.pluginId] ?? { enabled: false, config: {} };
    plugins[req.params.pluginId] = { ...cfg, config: body.config };
    await query(`UPDATE sessions SET plugins = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(plugins), body.sessionId]);
    res.json({ ok: true });
  })
);
