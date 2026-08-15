import fs from 'fs';
import path from 'path';
import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { pool } from './config/database';
import { closeRedis } from './config/redis';
import { createSocketServer } from './socket';
import { startAllSessions } from './services/sessionManager';
import { startAutomationLoop } from './services/automationService';
import { logger } from './utils/logger';

async function ensureSchema(): Promise<void> {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  logger.info('database schema ready');
}

async function main(): Promise<void> {
  await ensureSchema();

  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);

  // Restore previously-linked WhatsApp sessions
  await startAllSessions();
  startAutomationLoop();

  server.listen(env.PORT, () => {
    logger.info(`${env.WA_BOT_NAME} backend listening on :${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    io.close();
    server.close();
    await closeRedis();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
