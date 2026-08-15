import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler, notFound } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { healthRouter } from './routes/health';
import { sessionsRouter } from './routes/sessions';
import { pluginsRouter } from './routes/plugins';
import { customersRouter } from './routes/customers';
import { broadcastsRouter } from './routes/broadcasts';
import { automationsRouter } from './routes/automations';
import { aiRouter } from './routes/ai';
import { apikeysRouter } from './routes/apikeys';
import { logsRouter } from './routes/logs';
import { metricsRouter } from './routes/metrics';

export function createApp(): express.Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Allow requests with no origin (curl, server-to-server) plus configured origins.
        if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', apiLimiter);

  // Public
  app.use('/api/v1', healthRouter); // /api/v1/health, /api/v1/ready
  app.use('/api/v1/auth', authRouter);

  // Authenticated
  app.use('/api/v1/sessions', sessionsRouter);
  app.use('/api/v1/plugins', pluginsRouter);
  app.use('/api/v1/customers', customersRouter);
  app.use('/api/v1/broadcasts', broadcastsRouter);
  app.use('/api/v1/automations', automationsRouter);
  app.use('/api/v1/ai', aiRouter);
  app.use('/api/v1/api-keys', apikeysRouter);
  app.use('/api/v1/logs', logsRouter);
  app.use('/api/v1/metrics', metricsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
