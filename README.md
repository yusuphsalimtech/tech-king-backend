# Tech King — Backend (VPS)

Node.js + TypeScript + Express + Baileys + PostgreSQL + Redis + BullMQ + Socket.IO.

Runs **only on a Linux VPS** — never on Vercel.

## Responsibilities

- WhatsApp multi-session (Baileys) + pairing codes
- 64-char session credentials (hashed at rest, issued once)
- Plugins engine (auto-reply, greeting, AI assistant)
- Broadcasts via BullMQ queue with live progress
- Automations (interval + keyword triggers)
- AI gateway (OpenAI-compatible)
- Customers, messages, audit logs
- JWT auth + RBAC + API keys + rate limiting
- Socket.IO realtime events

## Environment

```env
NODE_ENV=production
PORT=4000
DATABASE_URL=postgres://techking:CHANGE_ME@localhost:5432/tech_king
REDIS_URL=redis://localhost:6379/6
JWT_SECRET=CHANGE_ME_64_chars_random
FRONTEND_URL=https://automation.shimbawifi.xyz
CORS_ORIGINS=https://automation.shimbawifi.xyz,http://localhost:3000
DATA_DIR=./data
```

## Run

```bash
npm install
cp .env.example .env
npm run migrate   # creates schema + seeds plugins
npm run build
npm start
```

## PM2 (production)

```bash
npm run build
pm2 start ecosystem.config.js   # process name: tech-king-backend
pm2 save
pm2 startup
```

## Docker

```bash
docker compose up -d --build    # postgres + redis + backend
```

## Key directories

```
src/config/     env, database pool, redis
src/db/         schema + migration
src/middleware/ auth, RBAC, rate limit, errors
src/routes/     /api/v1 endpoints
src/services/   session manager, plugins, broadcasts, automations, AI, metrics
src/socket/     Socket.IO server + event routing
```
