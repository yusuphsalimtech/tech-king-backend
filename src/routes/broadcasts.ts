import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, HttpError } from '../utils/helpers';
import { enqueueBroadcast } from '../services/broadcastService';
import { audit } from '../utils/audit';

export const broadcastsRouter = Router();
broadcastsRouter.use(requireAuth);

function toJid(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('@')) return trimmed;
  return `${trimmed.replace(/[^\d]/g, '')}@s.whatsapp.net`;
}

broadcastsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query<any>(
      `SELECT b.*, s.name AS session_name FROM broadcasts b
       LEFT JOIN sessions s ON s.id = b.session_id
       WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT 100`,
      [req.user!.id]
    );
    res.json({ broadcasts: rows });
  })
);

broadcastsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = await queryOne<any>(
      `SELECT b.*, s.name AS session_name FROM broadcasts b LEFT JOIN sessions s ON s.id = b.session_id WHERE b.id = $1 AND b.user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!b) throw new HttpError(404, 'Broadcast not found');
    const recipients = await query<any>(
      `SELECT id, jid, phone, status, error, sent_at FROM broadcast_recipients WHERE broadcast_id = $1 ORDER BY id LIMIT 1000`,
      [req.params.id]
    );
    res.json({ broadcast: b, recipients });
  })
);

const createSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(4000),
  recipients: z.array(z.string().min(3).max(100)).min(1).max(5000),
});

broadcastsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const session = await queryOne<{ user_id: number }>(
      `SELECT user_id FROM sessions WHERE id = $1`,
      [body.sessionId]
    );
    if (!session) throw new HttpError(404, 'Session not found');
    if (session.user_id !== req.user!.id) throw new HttpError(403, 'This session belongs to another account');

    const jids = [...new Set(body.recipients.map(toJid))];
    const row = await queryOne<any>(
      `INSERT INTO broadcasts (user_id, session_id, message, total) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user!.id, body.sessionId, body.message, jids.length]
    );

    const values: unknown[] = [];
    const params: string[] = [];
    jids.forEach((jid, i) => {
      const base = i * 3;
      params.push(`($1, $${base + 2}, $${base + 3}, 'pending')`);
      values.push(jid, jidToPhone(jid));
    });
    await query(
      `INSERT INTO broadcast_recipients (broadcast_id, jid, phone, status) VALUES ${params.join(', ')} ON CONFLICT (broadcast_id, jid) DO NOTHING`,
      [row.id, ...values]
    );

    await enqueueBroadcast(row.id);
    await audit('broadcast.create', { userId: req.user!.id }, { id: row.id, recipients: jids.length });

    res.status(201).json({ broadcast: row });
  })
);

broadcastsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = await queryOne<any>(
      `SELECT id FROM broadcasts WHERE id = $1 AND user_id = $2 AND status IN ('queued','running')`,
      [req.params.id, req.user!.id]
    );
    if (!b) throw new HttpError(404, 'Broadcast not found or already finished');
    await query(`UPDATE broadcasts SET status = 'failed', updated_at = now() WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, message: 'Broadcast cancelled' });
  })
);

function jidToPhone(jid: string): string | null {
  const m = jid.match(/^(\d+)@/);
  return m ? m[1] : null;
}
