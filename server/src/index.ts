import { createApp } from './app';
import { config } from './config';
import { logger } from './logger';
import { startWebhookWorker } from './services/webhooks';
import { startExpirySweeper } from './services/expiry';

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info('agentaction server listening', { port: config.port, env: config.env });
});

const stopWebhooks = startWebhookWorker();
const stopExpiry = startExpirySweeper();

function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  stopWebhooks();
  stopExpiry();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
