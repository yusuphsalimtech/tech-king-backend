import type { WASocket } from '@whiskeysockets/baileys';
import { queryOne, query } from '../config/database';
import { aiChat } from './aiService';
import { logger } from '../utils/logger';

export interface IncomingMessage {
  sessionId: string;
  jid: string;
  phone: string;
  name?: string;
  text?: string;
  isGroup: boolean;
  isNewChat: boolean;
}

export interface PluginContext {
  sock: WASocket;
  sessionId: string;
  reply: (text: string) => Promise<void>;
}

export interface Plugin {
  id: string;
  name: string;
  description: string;
  version: string;
  /** Return true to mark the message as handled (stops further plugins). */
  handle: (msg: IncomingMessage, ctx: PluginContext) => Promise<boolean | void>;
}

interface PluginConfig {
  enabled: boolean;
  config?: Record<string, unknown>;
}

export async function replyTo(sock: WASocket, jid: string, text: string): Promise<void> {
  await sock.sendMessage(jid, { text });
}

async function isNewChat(sessionId: string, jid: string): Promise<boolean> {
  const row = await queryOne(`SELECT 1 FROM customers WHERE session_id = $1 AND jid = $2`, [sessionId, jid]);
  return !row;
}

const greetingPlugin: Plugin = {
  id: 'greeting',
  name: 'Greeting',
  description: 'Sends a welcome message to new conversations.',
  version: '1.0.0',
  async handle(msg, ctx) {
    if (msg.isGroup || !msg.isNewChat || !msg.text) return false;
    const cfg = await getPluginConfig(ctx.sessionId, 'greeting');
    const text = (cfg?.config?.text as string) || `Hello ${msg.name || 'there'}! Welcome to TECH KING AUTOMATION 🚀\nHow can I help you today?`;
    await ctx.reply(text);
    return false;
  },
};

const autoReplyPlugin: Plugin = {
  id: 'auto-reply',
  name: 'Auto Reply',
  description: 'Replies to messages matching keyword rules.',
  version: '1.0.0',
  async handle(msg, ctx) {
    if (!msg.text || msg.isGroup) return false;
    const cfg = await getPluginConfig(ctx.sessionId, 'auto-reply');
    const rules = (cfg?.config?.rules as Array<{ keywords: string[]; reply: string }>) || [];
    const lower = msg.text.toLowerCase();
    for (const rule of rules) {
      if (rule.keywords.some((k) => lower.includes(k.toLowerCase()))) {
        await ctx.reply(rule.reply);
        return true;
      }
    }
    return false;
  },
};

const aiAssistantPlugin: Plugin = {
  id: 'ai-assistant',
  name: 'AI Assistant',
  description: 'Answers messages with the configured AI provider.',
  version: '1.0.0',
  async handle(msg, ctx) {
    if (!msg.text || msg.isGroup) return false;
    const cfg = await getPluginConfig(ctx.sessionId, 'ai-assistant');
    const system = (cfg?.config?.systemPrompt as string) || 'You are the TECH KING automation assistant. Answer concisely and helpfully.';
    try {
      const reply = await aiChat({
        system,
        messages: [{ role: 'user', content: msg.text }],
        maxTokens: 300,
      });
      if (reply) await ctx.reply(reply);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'ai assistant plugin failed');
    }
    return true;
  },
};

export const builtinPlugins: Plugin[] = [greetingPlugin, autoReplyPlugin, aiAssistantPlugin];

const pluginMap = new Map(builtinPlugins.map((p) => [p.id, p]));

export function getPlugin(id: string): Plugin | undefined {
  return pluginMap.get(id);
}

export function listPlugins(): Plugin[] {
  return builtinPlugins;
}

async function getPluginConfig(sessionId: string, pluginId: string): Promise<PluginConfig | null> {
  const row = await queryOne<{ plugins: Record<string, PluginConfig> }>(
    `SELECT plugins FROM sessions WHERE id = $1`,
    [sessionId]
  );
  if (!row) return null;
  return row.plugins?.[pluginId] ?? null;
}

/** Run all enabled plugins for a session against an incoming message. */
export async function runPlugins(msg: IncomingMessage, ctx: PluginContext): Promise<void> {
  const row = await queryOne<{ plugins: Record<string, PluginConfig> }>(
    `SELECT plugins FROM sessions WHERE id = $1`,
    [ctx.sessionId]
  );
  if (!row?.plugins) return;
  for (const [pluginId, cfg] of Object.entries(row.plugins)) {
    if (!cfg?.enabled) continue;
    const plugin = pluginMap.get(pluginId);
    if (!plugin) continue;
    try {
      const handled = await plugin.handle(msg, ctx);
      if (handled) return;
    } catch (err) {
      logger.error({ err: (err as Error).message, pluginId }, 'plugin execution failed');
    }
  }
}

export async function listAvailablePluginsFromDb(): Promise<any[]> {
  return query(`SELECT * FROM plugins ORDER BY name`);
}
