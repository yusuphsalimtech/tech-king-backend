import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  makeWASocket,
  useMultiFileAuthState,
  type AnyMessageContent,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { env } from '../config/env';
import { query, queryOne } from '../config/database';
import { counter } from '../config/redis';
import { generateCredential, jidToPhone, sha256 } from '../utils/helpers';
import { logger } from '../utils/logger';
import { runPlugins } from './pluginEngine';

export interface SessionRecord {
  id: string;
  user_id: number | null;
  name: string;
  status: string;
  phone: string | null;
  pairing_code: string | null;
  credential_hash: string | null;
  credential_hint: string | null;
  credential_expires_at: Date | null;
  plugins: Record<string, { enabled: boolean; config?: Record<string, unknown> }>;
  settings: Record<string, unknown>;
  last_seen_at: Date | null;
  created_at: Date;
}

interface RuntimeSession {
  sock: WASocket | null;
  state: string; // connecting | pairing | open | closing | close | undefined
  stopping: boolean;
}

// Session events emitted for the Socket.IO layer:
// session.created | session.updated | session.pairing | session.connected |
// session.reconnecting | session.disconnected | session.credential | message.received | message.sent
export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(100);

const runtime = new Map<string, RuntimeSession>();
const sessionsDir = path.join(env.DATA_DIR, 'sessions');

if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

function emit(event: string, payload: Record<string, unknown>): void {
  sessionEvents.emit(event, payload);
}

async function getSession(id: string): Promise<SessionRecord | null> {
  return queryOne<SessionRecord>(`SELECT * FROM sessions WHERE id = $1`, [id]);
}

function publicSession(s: SessionRecord): Record<string, unknown> {
  return {
    id: s.id,
    user_id: s.user_id,
    name: s.name,
    status: s.status,
    phone: s.phone,
    pairing_code: s.pairing_code,
    credential_hint: s.credential_hint,
    credential_expires_at: s.credential_expires_at,
    credential_attached: Boolean(s.credential_hash),
    plugins: s.plugins,
    settings: s.settings,
    last_seen_at: s.last_seen_at,
    created_at: s.created_at,
  };
}

function extractText(msg: any): string {
  try {
    const type = getContentType(msg.message);
    if (!type) return '';
    if (type === 'conversation') return msg.message?.conversation ?? '';
    if (type === 'extendedTextMessage') return msg.message?.extendedTextMessage?.text ?? '';
    if (type === 'imageMessage') return msg.message?.imageMessage?.caption ?? '';
    if (type === 'videoMessage') return msg.message?.videoMessage?.caption ?? '';
    if (type === 'documentMessage') return msg.message?.documentMessage?.caption ?? '';
    return '';
  } catch {
    return '';
  }
}

async function createCredential(sessionId: string, phone: string, sock: WASocket): Promise<string> {
  const credential = generateCredential();
  const expires = new Date(Date.now() + env.SESSION_CREDENTIAL_TTL_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `UPDATE sessions SET credential_hash = $1, credential_hint = $2, credential_expires_at = $3, updated_at = now() WHERE id = $4`,
    [sha256(credential), credential.slice(-4), expires, sessionId]
  );
  // Send the session message to the paired WhatsApp number immediately (shown once only).
  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, {
      text:
        `🌟 *TECH-KING SESSION* 🌟\n\n` +
        `👋 *Hello Friend!*\n\n` +
        `Just a minute we are generating your session ✅\n\n` +
        `Loading... 10\n` +
        `▬▬▬▬▬▬▬▬▬▬\n` +
        `*SESSION CREDENTIAL*\n` +
        `\`\`\`${credential}\`\`\`\n\n` +
        `*Deploy your bot now*\n` +
        `> ${env.FRONTEND_URL || 'https://automation.shimbawifi.xyz'}\n\n` +
        `*How to deploy*\n` +
        `> ${env.FRONTEND_URL || 'https://automation.shimbawifi.xyz'}/sessions\n` +
        `▬▬▬▬▬▬▬▬▬▬\n\n` +
        `_Expires in ${env.SESSION_CREDENTIAL_TTL_DAYS} days. Keep it secret — it grants access to this session._`,
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, sessionId }, 'failed to send credential');
  }
  // Expose the credential once over the owner's realtime socket (shown once, then gone).
  emit('session.credential', { sessionId, phone, hint: credential.slice(-4), credential });
  return credential;
}

async function handleConnectionUpdate(sessionId: string, update: any, sock: WASocket): Promise<void> {
  const s = await getSession(sessionId);
  if (!s) return;

  if (update.connection === 'open') {
    const phone = s.phone || (sock.user?.id ? jidToPhone(sock.user.id) : null);
    await query(
      `UPDATE sessions SET status = 'connected', phone = COALESCE($1, phone), last_seen_at = now(), updated_at = now() WHERE id = $2`,
      [phone, sessionId]
    );
    emit('session.connected', { sessionId, phone });

    // Issue a fresh credential only on a brand-new login or first link.
    if (update.isNewLogin || !s.credential_hash) {
      if (phone) {
        await createCredential(sessionId, phone, sock);
      }
    }
    return;
  }

  if (update.connection === 'close') {
    const statusCode = (update.lastDisconnect?.error as any)?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    const rt = runtime.get(sessionId);
    if (rt) {
      rt.sock = null;
      rt.state = 'close';
    }

    if (loggedOut) {
      await query(`UPDATE sessions SET status = 'disconnected', phone = NULL, updated_at = now() WHERE id = $1`, [sessionId]);
      emit('session.disconnected', { sessionId, reason: 'logged_out' });
      logger.info({ sessionId }, 'session logged out');
      return;
    }

    await query(`UPDATE sessions SET status = 'reconnecting', updated_at = now() WHERE id = $1`, [sessionId]);
    emit('session.reconnecting', { sessionId, code: statusCode });

    // Auto-reconnect with backoff — only if the session is still wanted.
    const rt2 = runtime.get(sessionId);
    if (rt2 && !rt2.stopping) {
      const delay = Math.min(60_000, 5_000 + (statusCode ?? 0) * 100);
      setTimeout(() => {
        if (runtime.get(sessionId) && !runtime.get(sessionId)!.stopping) {
          void startSession(sessionId).catch((err) =>
            logger.error({ err: (err as Error).message, sessionId }, 'reconnect failed')
          );
        }
      }, delay);
    }
  }
}

async function handleMessagesUpsert(sessionId: string, upsert: any, sock: WASocket): Promise<void> {
  const messages = upsert.messages ?? [];
  for (const msg of messages) {
    try {
      await handleMessage(sessionId, msg, sock);
    } catch (err) {
      logger.error({ err: (err as Error).message, sessionId }, 'message handling failed');
    }
  }
}

async function handleMessage(sessionId: string, msg: any, sock: WASocket): Promise<void> {
  const key = msg.key;
  if (!key?.remoteJid) return;
  const jid = key.remoteJid as string;
  if (jid === 'status@broadcast') return;

  const fromMe = Boolean(key.fromMe);
  const type = getContentType(msg.message);
  const text = extractText(msg);
  const isGroup = jid.endsWith('@g.us');
  const phone = jidToPhone(jid);

  if (fromMe) {
    await counter.inc('messages');
    if (text.startsWith('!')) await counter.inc('commands');
    try {
      await query(
        `INSERT INTO messages (session_id, direction, jid, phone, type, body) VALUES ($1,'out',$2,$3,$4,$5)`,
        [sessionId, jid, phone, type, text.slice(0, 4000)]
      );
    } catch { /* non-critical */ }
    emit('message.sent', { sessionId, to: jid, text: text.slice(0, 200) });
    return;
  }

  // Incoming
  await counter.inc('messages');
  if (text.startsWith('!')) await counter.inc('commands');

  try {
    await query(
      `INSERT INTO messages (session_id, direction, jid, phone, type, body) VALUES ($1,'in',$2,$3,$4,$5)`,
      [sessionId, jid, phone, type, text.slice(0, 4000)]
    );
  } catch { /* non-critical */ }

  let isNew = false;
  if (!isGroup) {
    const pushName = (msg.pushName as string) || null;
    const existing = await queryOne(`SELECT id FROM customers WHERE session_id = $1 AND jid = $2`, [sessionId, jid]);
    isNew = !existing;
    try {
      await query(
        `INSERT INTO customers (user_id, session_id, jid, phone, name, last_interaction_at)
         SELECT user_id, $2, $3, $4, COALESCE($5, name), now() FROM sessions WHERE id = $2
         ON CONFLICT (session_id, jid) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, customers.name),
           phone = COALESCE(EXCLUDED.phone, customers.phone),
           last_interaction_at = now()`,
        [sessionId, jid, phone, pushName]
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'customer upsert failed');
    }
  }

  emit('message.received', {
    sessionId,
    from: jid,
    phone,
    name: msg.pushName || null,
    text: text.slice(0, 200),
    type,
    isGroup,
    isNew,
  });

  // Plugin engine (fire and forget — never blocks the message loop)
  if (text) {
    void runPlugins(
      { sessionId, jid, phone, name: msg.pushName, text, isGroup, isNewChat: isNew },
      {
        sock,
        sessionId,
        reply: async (replyText: string) => {
          await sock.sendMessage(jid, { text: replyText });
        },
      }
    ).catch((err) => logger.error({ err: (err as Error).message, sessionId }, 'plugin run failed'));
  }
}

export async function startSession(sessionId: string): Promise<void> {
  const s = await getSession(sessionId);
  if (!s) throw new Error('Session not found');

  const existing = runtime.get(sessionId);
  if (existing?.sock) return; // already running

  const rt: RuntimeSession = { sock: null, state: 'connecting', stopping: false };
  runtime.set(sessionId, rt);

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionsDir, sessionId));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'warn' }),
    browser: ['Tech King', 'Chrome', '1.0.0'],
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  rt.sock = sock;

  sock.ev.on('creds.update', () => void saveCreds().catch(() => undefined));
  sock.ev.on('connection.update', (update) => {
    if (update.connection) rt.state = update.connection;
    void handleConnectionUpdate(sessionId, update, sock);
  });
  sock.ev.on('messages.upsert', (upsert) => void handleMessagesUpsert(sessionId, upsert, sock));

  await query(`UPDATE sessions SET status = 'connecting', updated_at = now() WHERE id = $1`, [sessionId]);
  emit('session.updated', { sessionId, status: 'connecting' });

  logger.info({ sessionId }, 'session started');
}

/**
 * Wait for the Baileys socket to be ready before requesting a pairing code.
 * Mirrors the Shimba bot: waits up to 15s, restarts the socket once if it
 * dies mid-wait (stale session), so "not ready" only surfaces after a timeout.
 */
async function waitForSocketReady(sessionId: string, maxMs = 15000): Promise<boolean> {
  const startedAt = Date.now();
  let restarted = false;
  while (Date.now() - startedAt < maxMs) {
    const rt = runtime.get(sessionId);
    if (!rt?.sock && !restarted) {
      restarted = true;
      logger.warn({ sessionId }, 'socket gone during pairing wait — restarting session');
      await startSession(sessionId).catch(() => undefined);
      continue;
    }
    // Mirror the Shimba bot: only treat the socket as ready once Baileys has
    // actually reached a usable state (connecting/qr/pairing/open) — not merely
    // because the socket object exists. Otherwise requestPairingCode fires
    // before the websocket is up and dies with "Connection Closed".
    if (rt?.sock && rt.state && ['connecting', 'qr', 'pairing', 'open'].includes(rt.state)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return Boolean(runtime.get(sessionId)?.sock);
}

export async function requestPairingCode(sessionId: string, rawPhone: string): Promise<string> {
  const s = await getSession(sessionId);
  if (!s) throw new Error('Session not found');

  const phone = rawPhone.replace(/[^\d]/g, '');
  if (!/^\d{8,15}$/.test(phone)) throw new Error('Invalid phone number');

  await startSession(sessionId);
  const ready = await waitForSocketReady(sessionId, 15000);
  const rt = runtime.get(sessionId);
  if (!ready || !rt?.sock) {
    throw new Error('Bot is not ready yet — wait for the socket to initialize, then try again');
  }

  const code = await rt.sock.requestPairingCode(phone);
  await query(`UPDATE sessions SET status = 'pairing', phone = $1, pairing_code = $2, updated_at = now() WHERE id = $3`, [
    phone,
    code,
    sessionId,
  ]);
  emit('session.pairing', { sessionId, code });
  return code;
}

export async function stopSession(sessionId: string): Promise<void> {
  const rt = runtime.get(sessionId);
  if (rt) {
    rt.stopping = true;
    try {
      rt.sock?.end(undefined);
    } catch { /* ignore */ }
    rt.sock = null;
    runtime.delete(sessionId);
  }
  await query(`UPDATE sessions SET status = 'disconnected', updated_at = now() WHERE id = $1`, [sessionId]);
  emit('session.disconnected', { sessionId, reason: 'manual_stop' });
}

export async function restartSession(sessionId: string): Promise<void> {
  await stopSession(sessionId);
  await query(`UPDATE sessions SET status = 'connecting', updated_at = now() WHERE id = $1`, [sessionId]);
  await startSession(sessionId);
}

export async function disconnectSession(sessionId: string): Promise<void> {
  await stopSession(sessionId);
}

export async function sendMessage(sessionId: string, jid: string, content: AnyMessageContent): Promise<void> {
  const s = await getSession(sessionId);
  if (!s) throw new Error('Session not found');
  const rt = runtime.get(sessionId);
  if (!rt?.sock) throw new Error('Session is not connected');
  await rt.sock.sendMessage(jid, content);
  await query(
    `INSERT INTO messages (session_id, direction, jid, phone, type, body) VALUES ($1,'out',$2,$3,'text',$4)`,
    [sessionId, jid, jidToPhone(jid), (content as any).text ?? '']
  );
  await counter.inc('messages');
  emit('message.sent', { sessionId, to: jid, text: ((content as any).text ?? '').slice(0, 200) });
}

export function isConnected(sessionId: string): boolean {
  const rt = runtime.get(sessionId);
  return Boolean(rt?.sock);
}

/** Restore previously-linked sessions on boot. */
export async function startAllSessions(): Promise<void> {
  const rows = await query<SessionRecord>(`SELECT * FROM sessions WHERE credential_hash IS NOT NULL`);
  for (const s of rows) {
    void startSession(s.id).catch((err) =>
      logger.error({ err: (err as Error).message, sessionId: s.id }, 'auto-start failed')
    );
  }
  logger.info({ restored: rows.length }, 'sessions restored');
}

export { publicSession, getSession };
