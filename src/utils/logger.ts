import pino from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let loggerInstance: pino.Logger | null = null;

export function createLogger(level: LogLevel = 'info'): pino.Logger {
  if (loggerInstance) {
    return loggerInstance;
  }

  loggerInstance = pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  });

  return loggerInstance;
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    return createLogger();
  }
  return loggerInstance;
}

export type Logger = pino.Logger;
