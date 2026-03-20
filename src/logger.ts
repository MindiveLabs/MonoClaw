import pino from 'pino';
import pretty from 'pino-pretty';

const dest = process.env.NODE_ENV !== 'production'
  ? pretty({
      colorize: true,
      destination: process.stderr.fd,
      sync: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
      singleLine: true,
    })
  : pino.destination(2);

export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' }, dest);

export function flushLogger(): void {
  logger.flush();
}
