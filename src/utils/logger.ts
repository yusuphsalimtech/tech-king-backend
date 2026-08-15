import pino from 'pino';
import { env } from '../config/env';
import { query } from '../config/database';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { app: 'tech-king-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Buffered DB logging — flushed every 5s so hot paths never block.
let buffer: Array<{ level: string; source: string; message: string; meta: unknown }> = [];
let flushing = false;

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const rows = buffer;
  buffer = [];
  try {
    const values: unknown[] = [];
    const params: string[] = [];
    rows.forEach((r, i) => {
      const base = i * 3;
      params.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      values.push(r.level, r.source, r.message, JSON.stringify(r.meta ?? null));
    });
    await query(
      `INSERT INTO logs (level, source, message, meta) VALUES ${params.join(', ')}`,
      values
    );
  } catch {
    // DB logging must never crash the app
  } finally {
    flushing = false;
  }
}

setInterval(flush, 5_000).unref();

export function dbLog(level: 'trace' | 'debug' | 'info' | 'warn' | 'error', source: string, message: string, meta?: unknown): void {
  buffer.push({ level, source, message, meta });
  if (buffer.length > 500) void flush();
}

export async function getLogs(limit = 100, level?: string): Promise<any[]> {
  if (level) {
    return query(
      `SELECT * FROM logs WHERE level = $1 ORDER BY id DESC LIMIT $2`,
      [level, limit]
    );
  }
  return query(`SELECT * FROM logs ORDER BY id DESC LIMIT $1`, [limit]);
}
