import { Queue, Worker, type Job } from 'bullmq';
import { redis } from '../config/redis';
import { query, queryOne } from '../config/database';
import { isConnected, sendMessage, sessionEvents } from './sessionManager';
import { sleep } from '../utils/helpers';
import { logger } from '../utils/logger';

export const broadcastQueue = new Queue('broadcasts', { connection: redis });

function emitProgress(broadcast: any, sent: number, failed: number, status?: string): void {
  sessionEvents.emit('broadcast.progress', {
    broadcastId: broadcast.id,
    userId: broadcast.user_id,
    sessionId: broadcast.session_id,
    total: broadcast.total,
    sent,
    failed,
    pending: Math.max(0, broadcast.total - sent - failed),
    status: status ?? 'running',
  });
}

const worker = new Worker(
  'broadcasts',
  async (job: Job<{ broadcastId: string }>) => {
    const { broadcastId } = job.data;
    const b = await queryOne<any>(`SELECT * FROM broadcasts WHERE id = $1`, [broadcastId]);
    if (!b) return;

    await query(`UPDATE broadcasts SET status = 'running', updated_at = now() WHERE id = $1`, [broadcastId]);

    if (!isConnected(b.session_id)) {
      throw new Error('Session is not connected — start/reconnect it before broadcasting');
    }

    const recipients = await query<any>(
      `SELECT * FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'pending' ORDER BY id`,
      [broadcastId]
    );

    let sent = b.sent || 0;
    let failed = b.failed || 0;
    const total = recipients.length + sent + failed;

    for (const r of recipients) {
      try {
        await sendMessage(b.session_id, r.jid, { text: b.message });
        await query(`UPDATE broadcast_recipients SET status = 'sent', sent_at = now() WHERE id = $1`, [r.id]);
        sent += 1;
      } catch (err) {
        await query(`UPDATE broadcast_recipients SET status = 'failed', error = $1 WHERE id = $2`, [
          (err as Error).message.slice(0, 500),
          r.id,
        ]);
        failed += 1;
      }
      const done = sent + failed;
      if (done % 5 === 0 || done === total) {
        await query(`UPDATE broadcasts SET sent = $1, failed = $2, updated_at = now() WHERE id = $3`, [sent, failed, broadcastId]);
        emitProgress(b, sent, failed);
      }
      await sleep(250); // gentle pacing to avoid WhatsApp rate limits
    }

    await query(`UPDATE broadcasts SET sent = $1, failed = $2, status = 'completed', updated_at = now() WHERE id = $3`, [
      sent,
      failed,
      broadcastId,
    ]);
    emitProgress(b, sent, failed, 'completed');
  },
  { connection: redis, concurrency: 2 }
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'broadcast job failed');
  const data = job?.data as { broadcastId?: string };
  if (data?.broadcastId) {
    query(`UPDATE broadcasts SET status = 'failed', updated_at = now() WHERE id = $1`, [data.broadcastId]).catch(() => undefined);
  }
});

worker.on('completed', (job) => {
  sessionEvents.emit('job.completed', { jobId: job.id });
});

export async function enqueueBroadcast(broadcastId: string): Promise<void> {
  await broadcastQueue.add('send', { broadcastId }, { removeOnComplete: 100, removeOnFail: 500 });
}

export async function getBroadcastStats(userId: number): Promise<{ active: number; failed: number }> {
  const [active, failed] = await Promise.all([
    queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM broadcasts WHERE user_id = $1 AND status IN ('queued','running')`,
      [userId]
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM broadcasts WHERE user_id = $1 AND status = 'failed'`,
      [userId]
    ),
  ]);
  return { active: active?.n ?? 0, failed: failed?.n ?? 0 };
}
