import os from 'os';
import { pool } from '../config/database';
import { counter } from '../config/redis';
import { checkDatabase } from '../config/database';
import { checkRedis } from '../config/redis';

export interface DashboardStats {
  messagesToday: number;
  commandsToday: number;
  customers: number;
  sessions: { total: number; connected: number; disconnected: number };
  jobs: { active: number; failed: number };
  broadcasts: { total: number; running: number };
  health: { status: string; uptime: number; cpu: number; memory: number };
}

export async function getDashboardStats(userId: number): Promise<DashboardStats> {
  const [messagesToday, commandsToday, customers, sessions, jobs, broadcasts] = await Promise.all([
    counter.get('messages'),
    counter.get('commands'),
    pool.query(`SELECT COUNT(*)::int AS n FROM customers WHERE user_id = $1`, [userId]),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'connected')::int AS connected,
              COUNT(*) FILTER (WHERE status IN ('disconnected','expired'))::int AS disconnected
       FROM sessions WHERE user_id = $1`,
      [userId]
    ),
    counter.get('jobs_failed'),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'running')::int AS running
       FROM broadcasts WHERE user_id = $1`,
      [userId]
    ),
  ]);

  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  return {
    messagesToday: Number(messagesToday) || 0,
    commandsToday: Number(commandsToday) || 0,
    customers: customers.rows[0].n,
    sessions: {
      total: sessions.rows[0].total,
      connected: sessions.rows[0].connected,
      disconnected: sessions.rows[0].disconnected,
    },
    jobs: { active: 0, failed: Number(commandsToday) ? 0 : Number(jobs) || 0 },
    broadcasts: { total: broadcasts.rows[0].total, running: broadcasts.rows[0].running },
    health: {
      status: 'healthy',
      uptime: Math.floor(process.uptime()),
      cpu: Math.round(process.cpuUsage().user / 10_000) / 100,
      memory: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
    },
  };
}

export async function getSystemHealth(): Promise<Record<string, unknown>> {
  const [db, redisOk, mem] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    Promise.resolve(process.memoryUsage()),
  ]);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    status: db.ok && redisOk.ok ? 'healthy' : 'degraded',
    database: db,
    redis: redisOk,
    whatsappSessions: await pool.query(`SELECT COUNT(*)::int AS n FROM sessions WHERE status = 'connected'`).then((r) => r.rows[0].n),
    uptime: Math.floor(process.uptime()),
    memory: {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      systemFreeMb: Math.round(freeMem / 1024 / 1024),
      systemTotalMb: Math.round(totalMem / 1024 / 1024),
    },
    node: process.version,
    platform: process.platform,
  };
}
