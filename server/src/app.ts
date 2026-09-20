import express from 'express';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { healthRouter } from './routes/health';
import { tenantsRouter } from './routes/tenants';
import { pairingsRouter } from './routes/pairings';
import { devicesRouter } from './routes/devices';
import { requestsRouter } from './routes/requests';
import { policiesRouter } from './routes/policies';
import { deviceRequestsRouter } from './routes/deviceRequests';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // The raw body is kept because devices sign a hash of exactly these bytes.
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf.toString('utf8');
      },
    }),
  );

  app.use('/health', healthRouter);
  app.use('/v1/tenants', tenantsRouter);
  app.use('/v1/pairings', pairingsRouter);
  app.use('/v1/devices', devicesRouter);
  app.use('/v1/requests', requestsRouter);
  app.use('/v1/policies', policiesRouter);
  // Phone-facing: every call is signed by the device key, never a bearer token.
  app.use('/v1/device/requests', deviceRequestsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
