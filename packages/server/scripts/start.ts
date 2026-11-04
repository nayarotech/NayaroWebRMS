import { createLogger, startNayaroServer, stopNayaroServer } from '../src/index';
import {
  enquiryHubFromEnvironment,
  loadEnvironment,
  mailerFromEnvironment,
  serverOptionsFromEnvironment,
} from './env';

loadEnvironment();
const logger = createLogger({
  scope: 'nayaro:api',
  level: process.env['NODE_ENV'] === 'production' ? 'info' : 'debug',
});

const handle = await startNayaroServer({
  ...serverOptionsFromEnvironment(),
  logger,
  mailer: mailerFromEnvironment(logger),
  enquiryHub: enquiryHubFromEnvironment(),
});

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down...`);
  void stopNayaroServer(handle).catch((error: unknown) => {
    logger.error('Shutdown failed', error);
    process.exitCode = 1;
  });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
