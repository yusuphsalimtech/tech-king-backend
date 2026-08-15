import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, clientIp, HttpError, sha256 } from '../utils/helpers';
import { audit } from '../utils/audit';
import {
  disconnectSession,
  getSession,
  publicSession,
  requestPairingCode,
  restartSession,
  sendMessage,
  sessionEvents,
  startSession,
} from '../services/sessionManager';
import { messageLimiter } from '../middleware/rateLimit';

export const sessionsRouter = Router();
sessionsRouter.use(requireAuth);

async function ownSession(userId: number, id: string): Promise<any> {
  const s = await getSession(id);
  if (!s) throw new HttpError(404, 'Session not found');
  if (s.user_id !== userId) throw new HttpError(403, 'This session belongs to another account');
  return s;
}

sessionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query<any>(`SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`, [req.user!.id]);
    res.json({ sessions: rows.map(publicSession) });
  })
);

const createSchema = z.object({
  name: z.string().min(1).max(60),
  settings: z.record(z.unknown()).optional(),
});

sessionsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const row = await queryOne<any>(
      `INSERT INTO sessions (user_id, name, settings) VALUES ($1, $2, $3) RETURNING *`,
      [req.user!.id, body.name, JSON.stringify(body.settings ?? {})]
    );
    sessionEvents.emit('session.created', { sessionId: row.id });
    await audit('session.create', { userId: req.user!.id, ip: clientIp(req) }, { name: body.name });
    res.status(201).json({ session: publicSession(row) });
  })
);

sessionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const s = await ownSession(req.user!.id, req.params.id);
    res.json({ session: publicSession(s) });
  })
);

const pairSchema = z.object({ phone: z.string().min(8).max(20) });

sessionsRouter.post(
  '/:id/pair',
  asyncHandler(async (req, res) => {
    await ownSession(req.user!.id, req.params.id);
    const body = pairSchema.parse(req.body);
    const code = await requestPairingCode(req.params.id, body.phone);
    await audit('session.pair', { userId: req.user!.id, ip: clientIp(req) }, { phone: body.phone });
    res.json({ pairingCode: code, instructions: 'Enter this code in WhatsApp → Linked devices → Link with phone number' });
  })
);

sessionsRouter.post(
  '/:id/reconnect',
  asyncHandler(async (req, res) => {
    await ownSession(req.user!.id, req.params.id);
    await restartSession(req.params.id);
    res.json({ ok: true, message: 'Session reconnecting' });
  })
);

sessionsRouter.post(
  '/:id/disconnect',
  asyncHandler(async (req, res) => {
    await ownSession(req.user!.id, req.params.id);
    await disconnectSession(req.params.id);
    res.json({ ok: true, message: 'Session disconnected' });
  })
);

sessionsRouter.post(
  '/:id/restart',
  asyncHandler(async (req, res) => {
    await ownSession(req.user!.id, req.params.id);
    await restartSession(req.params.id);
    res.json({ ok: true, message: 'Session restarted' });
  })
);

const sendSchema = z.object({
  jid: z.string().min(3).max(100),
  text: z.string().min(1).max(4000),
});

sessionsRouter.post(
  '/:id/send',
  messageLimiter,
  asyncHandler(async (req, res) => {
    await ownSession(req.user!.id, req.params.id);
    const body = sendSchema.parse(req.body);
    let jid = body.jid;
    if (!jid.includes('@')) jid = `${jid.replace(/[^\d]/g, '')}@s.whatsapp.net`;
    await sendMessage(req.params.id, jid, { text: body.text });
    res.json({ ok: true });
  })
);

const updateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  settings: z.record(z.unknown()).optional(),
  plugins: z.record(z.unknown()).optional(),
});

sessionsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    await ownSession(req.user!.id, req.params.id);
    const body = updateSchema.parse(req.body);
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (body.name !== undefined) { sets.push(`name = $${idx++}`); values.push(body.name); }
    if (body.settings !== undefined) { sets.push(`settings = $${idx++}`); values.push(JSON.stringify(body.settings)); }
    if (body.plugins !== undefined) { sets.push(`plugins = $${idx++}`); values.push(JSON.stringify(body.plugins)); }
    if (sets.length === 0) throw new HttpError(400, 'Nothing to update');
    sets.push(`updated_at = now()`);
    values.push(req.params.id);
    const row = await queryOne<any>(
      `UPDATE sessions SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    sessionEvents.emit('session.updated', { sessionId: row.id, status: row.status });
    res.json({ session: publicSession(row) });
  })
);

sessionsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const s = await ownSession(req.user!.id, req.params.id);
    await disconnectSession(s.id);
    await query(`DELETE FROM sessions WHERE id = $1`, [s.id]);
    await audit('session.delete', { userId: req.user!.id, ip: clientIp(req) }, { name: s.name });
    res.json({ ok: true, message: 'Session deleted' });
  })
);

// ── Attach a session by 64-char credential ────────────────────────────────
const attachSchema = z.object({
  credential: z.string().length(64),
});

sessionsRouter.post(
  '/attach',
  asyncHandler(async (req, res) => {
    const body = attachSchema.parse(req.body);
    const row = await queryOne<any>(
      `SELECT * FROM sessions WHERE credential_hash = $1`,
      [sha256(body.credential)]
    );
    if (!row) throw new HttpError(401, 'Invalid session credential');

    const expires = new Date(row.credential_expires_at);
    if (isNaN(expires.getTime()) || expires.getTime() < Date.now()) {
      await query(`UPDATE sessions SET status = 'expired', updated_at = now() WHERE id = $1`, [row.id]);
      throw new HttpError(401, 'Session credential expired — reconnect WhatsApp to get a new one');
    }

    if (row.user_id !== null && row.user_id !== req.user!.id) {
      throw new HttpError(403, 'This credential belongs to another account');
    }

    await query(`UPDATE sessions SET user_id = $1, updated_at = now() WHERE id = $2`, [req.user!.id, row.id]);
    await audit('session.attach', { userId: req.user!.id, ip: clientIp(req) }, { sessionId: row.id });

    // Start the session so it connects immediately.
    void startSession(row.id).catch(() => undefined);

    const fresh = await getSession(row.id);
    res.json({ session: fresh ? publicSession(fresh) : null, message: 'Session attached successfully' });
  })
);
