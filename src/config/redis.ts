import Redis from 'ioredis';
import { env } from './env';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on('error', (err) => {
  console.error('[redis] error', err.message);
});

export async function checkRedis(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    await redis.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message } as never;
  }
}

// Daily counters
export const counter = {
  async inc(key: string, by = 1): Promise<void> {
    const redisKey = `tk:counter:${new Date().toISOString().slice(0, 10)}:${key}`;
    await redis.multi().incrby(redisKey, by).expire(redisKey, 60 * 60 * 48).exec();
  },
  async get(key: string): Promise<number> {
    const redisKey = `tk:counter:${new Date().toISOString().slice(0, 10)}:${key}`;
    const v = await redis.get(redisKey);
    return v ? parseInt(v, 10) : 0;
  },
};

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
