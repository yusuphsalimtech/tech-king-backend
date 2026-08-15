import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../config/redis';

// Uses Redis when available, otherwise falls back to in-memory.
let store: any;
try {
  store = new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as Promise<any>,
  } as any);
} catch {
  store = undefined;
}

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store,
  message: { error: 'Too many requests, please slow down' },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
  store,
  message: { error: 'Too many auth attempts, try again later' },
});

export const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store,
  message: { error: 'Message rate limit exceeded' },
});
