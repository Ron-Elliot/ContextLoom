import pino from 'pino';

export const logger = pino({
  level: process.env['CONTEXTLOOM_LOG_LEVEL'] ?? 'info',
});
