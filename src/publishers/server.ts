import express, { type Express } from 'express';
import type { RSSFeedPublisher } from './rss-feed.js';
import type { Pipeline } from '../pipeline/index.js';
import { getLogger } from '../utils/logger.js';

export interface ServerConfig {
  port: number;
  audioDir: string;
  imagesDir?: string;
  feedPublisher: RSSFeedPublisher;
  pipeline?: Pipeline;
}

// 生成中かどうかのフラグ
let isGenerating = false;

export function createServer(config: ServerConfig): Express {
  const app = express();
  const logger = getLogger();

  // 音声ファイルの配信
  app.use('/audio', express.static(config.audioDir));

  // 画像ファイルの配信
  if (config.imagesDir) {
    app.use('/images', express.static(config.imagesDir));
  }

  // ダッシュボード
  app.get('/', (_req, res) => {
    res.header('Content-Type', 'text/html; charset=utf-8');
    res.send(getDashboardHtml(config.pipeline !== undefined));
  });

  // ヘルスチェックエンドポイント
  app.get('/health', (_req, res) => {
    res.status(200).send('OK');
  });

  // ステータスエンドポイント
  app.get('/status', (_req, res) => {
    res.json({
      healthy: true,
      generating: isGenerating,
    });
  });

  // 生成エンドポイント
  app.post('/generate', async (_req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    if (isGenerating) {
      res.status(409).json({ error: '生成中です。完了までお待ちください' });
      return;
    }

    isGenerating = true;
    logger.info('手動生成を開始します');

    try {
      const result = await config.pipeline.run();
      isGenerating = false;

      if (result.success) {
        logger.info({ episodeId: result.episodeId }, '手動生成が完了しました');
        res.json({
          success: true,
          episodeId: result.episodeId,
          episodeTitle: result.episodeTitle,
          articleCount: result.articleCount,
        });
      } else {
        logger.error({ error: result.error }, '手動生成が失敗しました');
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (error) {
      isGenerating = false;
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message }, '手動生成でエラーが発生しました');
      res.status(500).json({ success: false, error: message });
    }
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

function getDashboardHtml(canGenerate: boolean): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CuraCast Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 600px; margin: 0 auto; }
    h1 {
      font-size: 2rem;
      margin-bottom: 2rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .card {
      background: #16213e;
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1rem;
    }
    .card h2 { font-size: 1rem; color: #888; margin-bottom: 0.5rem; }
    .status { display: flex; align-items: center; gap: 0.5rem; }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #4ade80;
    }
    .status-dot.generating { background: #facc15; animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .links { display: flex; flex-direction: column; gap: 0.75rem; }
    .links a {
      color: #60a5fa;
      text-decoration: none;
      font-size: 1.1rem;
    }
    .links a:hover { text-decoration: underline; }
    button {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      width: 100%;
      transition: background 0.2s;
    }
    button:hover { background: #2563eb; }
    button:disabled { background: #555; cursor: not-allowed; }
    .message {
      margin-top: 1rem;
      padding: 0.75rem;
      border-radius: 8px;
      display: none;
    }
    .message.success { background: #166534; display: block; }
    .message.error { background: #991b1b; display: block; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎙️ CuraCast</h1>

    <div class="card">
      <h2>ステータス</h2>
      <div class="status">
        <span class="status-dot" id="statusDot"></span>
        <span id="statusText">確認中...</span>
      </div>
    </div>

    <div class="card">
      <h2>リンク</h2>
      <div class="links">
        <a href="/feed.xml" target="_blank">📡 RSSフィード</a>
        <a href="/health" target="_blank">💚 ヘルスチェック</a>
      </div>
    </div>

    ${canGenerate ? `
    <div class="card">
      <h2>エピソード生成</h2>
      <button id="generateBtn" onclick="generate()">🎬 今すぐ生成</button>
      <div class="message" id="message"></div>
    </div>
    ` : ''}
  </div>

  <script>
    async function checkStatus() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        const dot = document.getElementById('statusDot');
        const text = document.getElementById('statusText');
        if (data.generating) {
          dot.classList.add('generating');
          text.textContent = '生成中...';
        } else {
          dot.classList.remove('generating');
          text.textContent = '正常';
        }
      } catch {
        document.getElementById('statusText').textContent = 'エラー';
      }
    }

    async function generate() {
      const btn = document.getElementById('generateBtn');
      const msg = document.getElementById('message');
      btn.disabled = true;
      btn.textContent = '⏳ 生成中...';
      msg.className = 'message';
      msg.style.display = 'none';

      try {
        const res = await fetch('/generate', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          msg.textContent = '✅ 生成完了: ' + data.episodeTitle;
          msg.className = 'message success';
        } else {
          msg.textContent = '❌ エラー: ' + data.error;
          msg.className = 'message error';
        }
      } catch (e) {
        msg.textContent = '❌ 通信エラー';
        msg.className = 'message error';
      }
      btn.disabled = false;
      btn.textContent = '🎬 今すぐ生成';
      checkStatus();
    }

    checkStatus();
    setInterval(checkStatus, 5000);
  </script>
</body>
</html>`;
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
