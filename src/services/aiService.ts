import { env } from '../config/env';
import { HttpError } from '../utils/helpers';
import { logger } from '../utils/logger';

export interface AiChatOptions {
  system?: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
}

export async function aiChat(opts: AiChatOptions): Promise<string> {
  if (!env.AI_ENABLED || !env.AI_API_URL || !env.AI_API_KEY) {
    throw new HttpError(503, 'AI is not configured on this server');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${env.AI_API_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 500,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: text.slice(0, 300) }, 'ai request failed');
      throw new HttpError(502, 'AI provider request failed');
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new HttpError(504, 'AI request timed out');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
