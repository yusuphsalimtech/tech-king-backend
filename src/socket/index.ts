import type { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { env } from '../config/env';
import { queryOne } from '../config/database';
import { sessionEvents } from '../services/sessionManager';
import { logger } from '../utils/logger';

// sessionId -> userId cache (60s TTL) to avoid a DB hit per event
const ownerCache = new Map<string, number>();

function cachedOwner(sessionId: string): number | undefined {
  const cached = ownerCache.get(sessionId);
  if (cached !== undefined) return cached;
  return undefined;
}

async function getOwner(sessionId: string): Promise<number | null> {
  const cached = cachedOwner(sessionId);
  if (cached !== undefined) return cached;
  const row = await queryOne<{ user_id: number }>(`SELECT user_id FROM sessions WHERE id = $1`, [sessionId]);
  const owner = row?.user_id ?? null;
  if (owner !== null) {
    ownerCache.set(sessionId, owner);
    setTimeout(() => ownerCache.delete(sessionId), 60_000);
  }
  return owner;
}

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    maxHttpBufferSize: 1e6,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('unauthorized'));
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
      (socket.data as Record<string, unknown>).userId = parseInt(payload.sub, 10);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = (socket.data as Record<string, unknown>).userId as number;
    socket.join(`user:${userId}`);
    socket.emit('ready', { userId });
    logger.info({ userId, socketId: socket.id }, 'socket connected');
  });

  // ── Route app events to the owning user's room ─────────────────────────
  const sessionEventsList: string[] = [
    'session.created',
    'session.updated',
    'session.pairing',
    'session.connected',
    'session.reconnecting',
    'session.disconnected',
    'session.credential',
    'message.received',
    'message.sent',
  ];

  for (const event of sessionEventsList) {
    sessionEvents.on(event, (payload: any) => {
      void (async () => {
        const owner = await getOwner(payload.sessionId);
        if (owner !== null) io.to(`user:${owner}`).emit(event, payload);
      })();
    });
  }

  sessionEvents.on('broadcast.progress', (payload: any) => {
    io.to(`user:${payload.userId}`).emit('broadcast.progress', payload);
  });

  sessionEvents.on('job.completed', (payload: any) => {
    io.emit('job.completed', payload);
  });

  return io;
}
