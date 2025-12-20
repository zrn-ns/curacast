import pino from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ログエントリの型定義
export interface LogEntry {
  level: number;
  levelLabel: LogLevel;
  time: number;
  msg: string;
  [key: string]: unknown;
}

// ログバッファの設定
const MAX_LOG_BUFFER_SIZE = 500;
const logBuffer: LogEntry[] = [];

// SSEサブスクライバー管理
type LogSubscriber = (log: LogEntry) => void;
const subscribers = new Set<LogSubscriber>();

// ログレベル番号からラベルへの変換
function levelToLabel(level: number): LogLevel {
  if (level <= 20) return 'debug';
  if (level <= 30) return 'info';
  if (level <= 40) return 'warn';
  return 'error';
}

// ログレベルラベルから番号への変換
function labelToLevel(label: LogLevel): number {
  switch (label) {
    case 'debug':
      return 20;
    case 'info':
      return 30;
    case 'warn':
      return 40;
    case 'error':
      return 50;
  }
}

// ログをバッファに追加し、サブスクライバーに通知
function addLogEntry(entry: LogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }
  // 全サブスクライバーに通知
  for (const subscriber of subscribers) {
    try {
      subscriber(entry);
    } catch {
      // サブスクライバーのエラーは無視
    }
  }
}

let loggerInstance: pino.Logger | null = null;

export function createLogger(level: LogLevel = 'info'): pino.Logger {
  if (loggerInstance) {
    return loggerInstance;
  }

  // 元のpinoロガーを作成（pino-prettyで標準出力）
  const baseLogger = pino({
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

  // ログメソッドをラップして、バッファにも追加する
  function createWrappedLogger(logger: pino.Logger, bindings: object = {}): pino.Logger {
    const wrapped = Object.create(logger);

    for (const method of ['debug', 'info', 'warn', 'error', 'fatal'] as const) {
      wrapped[method] = function (objOrMsg: unknown, ...args: unknown[]) {
        // ログエントリを作成してバッファに追加
        const levelLabel = method === 'fatal' ? 'error' : method;
        const levelNum = labelToLevel(levelLabel);

        let msg: string;
        let extra: object = {};

        if (typeof objOrMsg === 'object' && objOrMsg !== null) {
          extra = objOrMsg as object;
          msg = typeof args[0] === 'string' ? args[0] : '';
        } else {
          msg = String(objOrMsg);
        }

        const entry: LogEntry = {
          level: levelNum,
          levelLabel,
          time: Date.now(),
          msg,
          ...bindings,
          ...extra,
        };

        addLogEntry(entry);

        // 元のロガーを呼び出す
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (logger[method] as any).call(logger, objOrMsg, ...args);
      };
    }

    // childメソッドをラップ
    wrapped.child = function (childBindings: pino.Bindings) {
      const childLogger = logger.child(childBindings);
      return createWrappedLogger(childLogger, { ...bindings, ...childBindings });
    };

    return wrapped as pino.Logger;
  }

  loggerInstance = createWrappedLogger(baseLogger);
  return loggerInstance;
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    return createLogger();
  }
  return loggerInstance;
}

// ログバッファを取得
export function getLogBuffer(): LogEntry[] {
  return [...logBuffer];
}

// ログバッファをクリア
export function clearLogBuffer(): void {
  logBuffer.length = 0;
}

// サブスクライバーを登録
export function subscribeToLogs(subscriber: LogSubscriber): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

// 現在のサブスクライバー数を取得
export function getSubscriberCount(): number {
  return subscribers.size;
}

export type Logger = pino.Logger;
