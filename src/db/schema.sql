-- Tech King Automation — database schema
-- This is a DEDICATED database. Never run it against Shimba WiFi's database.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'USER',      -- SUPERADMIN | ADMIN | USER
  language      TEXT NOT NULL DEFAULT 'en',        -- en | sw
  phone         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                BIGINT REFERENCES users(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'idle', -- idle | pairing | connecting | connected | reconnecting | disconnected | expired
  phone                  TEXT,
  pairing_code           TEXT,
  credential_hash        TEXT,
  credential_hint        TEXT,                        -- last 4 chars, for recognition only
  credential_expires_at  TIMESTAMPTZ,
  plugins                JSONB NOT NULL DEFAULT '{}', -- { "<pluginId>": { "enabled": bool, "config": {} } }
  settings               JSONB NOT NULL DEFAULT '{}',
  last_seen_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT REFERENCES users(id) ON DELETE CASCADE,
  session_id          UUID REFERENCES sessions(id) ON DELETE CASCADE,
  jid                 TEXT NOT NULL,
  phone               TEXT,
  name                TEXT,
  language            TEXT NOT NULL DEFAULT 'en',
  tags                 TEXT[] NOT NULL DEFAULT '{}',
  notes               TEXT,
  last_interaction_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, jid)
);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL,                          -- in | out
  jid        TEXT,
  phone      TEXT,
  type       TEXT,
  body       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plugins (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  version          TEXT NOT NULL DEFAULT '1.0.0',
  enabled_default  BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    BIGINT REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  total      INTEGER NOT NULL DEFAULT 0,
  sent       INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'queued',          -- queued | running | completed | failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id           BIGSERIAL PRIMARY KEY,
  broadcast_id UUID REFERENCES broadcasts(id) ON DELETE CASCADE,
  jid          TEXT NOT NULL,
  phone        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',       -- pending | sent | failed
  error        TEXT,
  sent_at      TIMESTAMPTZ,
  UNIQUE (broadcast_id, jid)
);

CREATE TABLE IF NOT EXISTS automations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        BIGINT REFERENCES users(id) ON DELETE CASCADE,
  session_id     UUID REFERENCES sessions(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  trigger_type   TEXT NOT NULL DEFAULT 'interval',    -- interval | keyword
  trigger_config JSONB NOT NULL DEFAULT '{}',         -- { minutes } | { keyword }
  action_type    TEXT NOT NULL DEFAULT 'send_message',
  action_config  JSONB NOT NULL DEFAULT '{}',         -- { text, jid | group }
  enabled        BOOLEAN NOT NULL DEFAULT true,
  next_run_at    TIMESTAMPTZ,
  last_run_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  key_hash    TEXT UNIQUE NOT NULL,
  prefix      TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS logs (
  id         BIGSERIAL PRIMARY KEY,
  level      TEXT NOT NULL DEFAULT 'info',
  source     TEXT,
  message    TEXT NOT NULL,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  detail     JSONB,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user        ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_session     ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created     ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_customers_user       ON customers(user_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_user      ON broadcasts(user_id);
CREATE INDEX IF NOT EXISTS idx_recipients_broadcast ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_automations_next_run ON automations(next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_logs_created         ON logs(created_at);

-- Seed: built-in plugins
INSERT INTO plugins (id, name, description, version, enabled_default) VALUES
  ('auto-reply',  'Auto Reply',  'Replies to incoming messages based on keyword rules you define.', '1.0.0', false),
  ('greeting',    'Greeting',    'Sends a welcome message to new conversations.', '1.0.0', true),
  ('ai-assistant','AI Assistant','Uses the configured AI provider to answer messages.', '1.0.0', false)
ON CONFLICT (id) DO NOTHING;
