import express from 'express';
import fs from 'fs';
import helmet from 'helmet';
import path from 'path';
import { authRouter, requireAuth } from './auth';
import { config } from './config';
import { dockerRouter } from './routes/docker';
import { kafkaRouter } from './routes/kafka';
import { kubernetesRouter } from './routes/kubernetes';
import { servicesRouter } from './routes/services';
import { sitesRouter } from './routes/sites';
import { ssoRouter } from './routes/sso';
import { systemRouter } from './routes/system';
import { isConfigured as kafkaConfigured } from './services/kafka';
import { isAvailable as kubernetesAvailable } from './services/kubernetes';
import { asyncHandler, errorMiddleware, HttpError } from './utils/http';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'connect-src': ["'self'", 'ws:', 'wss:'],
          // The TMS sign-in page (served through /platform/sso) submits a plain form to this host
          'form-action': ["'self'"],
          // Site screenshots are fetched with the bearer token and shown from blob: URLs
          'img-src': ["'self'", 'data:', 'blob:'],
        },
      },
    }),
  );
  // TMS single sign-on pages on this host; forwards raw bodies, so it sits before the JSON parser
  app.use('/platform/sso', ssoRouter);
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);

  const api = express.Router();
  api.use(requireAuth);
  api.get(
    '/capabilities',
    asyncHandler(async (_req, res) => {
      res.json({
        systemd: process.platform === 'linux',
        kafka: kafkaConfigured(),
        kubernetes: await kubernetesAvailable(),
        platform: process.platform,
      });
    }),
  );
  api.use('/system', systemRouter);
  api.use('/services', servicesRouter);
  api.use('/docker', dockerRouter);
  api.use('/kafka', kafkaRouter);
  api.use('/kubernetes', kubernetesRouter);
  api.use('/sites', sitesRouter);
  app.use('/api', api);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // Production: serve the built React app and let it handle client-side routes
  if (fs.existsSync(path.join(config.clientDist, 'index.html'))) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(config.clientDist, 'index.html'));
    });
  }

  app.use(errorMiddleware);
  return app;
}
