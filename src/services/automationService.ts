import { query } from '../config/database';
import { isConnected, sendMessage, sessionEvents } from './sessionManager';
import { logger } from '../utils/logger';

interface Automation {
  id: string;
  session_id: string;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  action_type: string;
  action_config: Record<string, unknown>;
}

async function executeAutomation(a: Automation, ctx: { jid?: string }): Promise<void> {
  try {
    if (a.action_type === 'send_message') {
      const target = (a.action_config?.jid as string) || ctx.jid;
      const text = (a.action_config?.text as string) || '';
      if (target && isConnected(a.session_id)) {
        await sendMessage(a.session_id, target, { text });
      }
    }
    await query(`UPDATE automations SET last_run_at = now(), updated_at = now() WHERE id = $1`, [a.id]);
  } catch (err) {
    logger.error({ err: (err as Error).message, automationId: a.id }, 'automation execution failed');
  }
}

async function checkKeywordAutomations(sessionId: string, jid: string, text: string): Promise<void> {
  if (!text) return;
  const automations = await query<Automation>(
    `SELECT * FROM automations WHERE session_id = $1 AND enabled AND trigger_type = 'keyword'`,
    [sessionId]
  );
  const lower = text.toLowerCase();
  for (const a of automations) {
    const keyword = String(a.trigger_config?.keyword ?? '').toLowerCase();
    if (keyword && lower.includes(keyword)) {
      await executeAutomation(a, { jid });
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startAutomationLoop(): void {
  // Keyword triggers — driven by the incoming-message event bus.
  sessionEvents.on('message.received', (p: any) => {
    void checkKeywordAutomations(p.sessionId, p.from, p.text).catch((err) =>
      logger.error({ err: (err as Error).message }, 'keyword automation failed')
    );
  });

  // Interval triggers — checked every 20 seconds.
  timer = setInterval(async () => {
    try {
      const due = await query<Automation>(
        `SELECT * FROM automations WHERE enabled AND trigger_type = 'interval' AND next_run_at <= now()`
      );
      for (const a of due) {
        await executeAutomation(a, {});
        const minutes = Math.max(1, Number(a.trigger_config?.minutes) || 60);
        await query(`UPDATE automations SET next_run_at = now() + ($1 || ' minutes')::interval WHERE id = $2`, [
          minutes,
          a.id,
        ]);
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'automation loop error');
    }
  }, 20_000);
  timer.unref();
  logger.info('automation loop started');
}
