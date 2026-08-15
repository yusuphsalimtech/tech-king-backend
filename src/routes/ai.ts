import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/helpers';
import { aiChat } from '../services/aiService';
import { counter } from '../config/redis';

export const aiRouter = Router();
aiRouter.use(requireAuth);

aiRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({ enabled: env.AI_ENABLED, model: env.AI_ENABLED ? env.AI_MODEL : null });
  })
);

const chatSchema = z.object({
  system: z.string().max(4000).optional(),
  messages: z
    .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().max(4000) }))
    .min(1)
    .max(40),
  maxTokens: z.number().int().min(16).max(2000).optional(),
});

aiRouter.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const body = chatSchema.parse(req.body);
    await counter.inc('ai_calls');
    const reply = await aiChat({ system: body.system, messages: body.messages, maxTokens: body.maxTokens });
    res.json({ reply });
  })
);
