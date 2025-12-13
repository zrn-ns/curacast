import express, { type Express } from 'express';
import path from 'path';
import type { RSSFeedPublisher } from './rss-feed.js';
import { getLogger } from '../utils/logger.js';

export interface ServerConfig {
  port: number;
  audioDir: string;
  imagesDir?: string;
  feedPublisher: RSSFeedPublisher;
}

export function createServer(config: ServerConfig): Express {
  const app = express();
  const logger = getLogger();

  // 音声ファイルの配信
  app.use('/audio', express.static(config.audioDir));

  // 画像ファイルの配信
  if (config.imagesDir) {
    app.use('/images', express.static(config.imagesDir));
  }

  // ヘルスチェックエンドポイント
  app.get('/health', (_req, res) => {
    res.status(200).send('OK');
  });

  // RSSフィードの配信
  app.get('/feed.xml', (_req, res) => {
    try {
      const feedXml = config.feedPublisher.getFeed();
      res.header('Content-Type', 'application/xml');
      res.send(feedXml);
      logger.debug('RSSフィードへのアクセス');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message }, 'フィード生成エラー');
      res.status(500).send('フィード生成エラー');
    }
  });

  return app;
}

export function startServer(app: Express, port: number): Promise<void> {
  const logger = getLogger();

  return new Promise((resolve) => {
    app.listen(port, () => {
      logger.info({ port }, `サーバーが起動しました: http://localhost:${port}`);
      resolve();
    });
  });
}
