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

  // データ統計エンドポイント
  app.get('/stats', async (_req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    try {
      const storage = config.pipeline.getStorage();
      res.json({
        processedArticles: storage.getProcessedCount(),
        failedUrls: storage.getFailedUrls().length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // 全エピソード削除エンドポイント
  app.post('/clear/episodes', async (_req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    try {
      logger.info('全エピソードの削除を開始');
      const result = await config.pipeline.clearAllEpisodes();
      logger.info(result, '全エピソードを削除しました');
      res.json({ success: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message }, 'エピソード削除エラー');
      res.status(500).json({ success: false, error: message });
    }
  });

  // ピックアップ済み記事クリアエンドポイント
  app.post('/clear/processed', async (_req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    try {
      logger.info('ピックアップ済み記事のクリアを開始');
      const cleared = await config.pipeline.clearProcessedArticles();
      logger.info({ cleared }, 'ピックアップ済み記事をクリアしました');
      res.json({ success: true, cleared });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message }, 'ピックアップ済み記事クリアエラー');
      res.status(500).json({ success: false, error: message });
    }
  });

  // 失敗URLクリアエンドポイント
  app.post('/clear/failed', async (_req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    try {
      logger.info('失敗URLのクリアを開始');
      const cleared = await config.pipeline.clearFailedUrls();
      logger.info({ cleared }, '失敗URLをクリアしました');
      res.json({ success: true, cleared });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message }, '失敗URLクリアエラー');
      res.status(500).json({ success: false, error: message });
    }
  });

  // 台本一覧エンドポイント
  app.get('/scripts', async (_req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    try {
      const scripts = await config.pipeline.getScripts();
      res.json({ scripts });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message }, '台本一覧取得エラー');
      res.status(500).json({ error: message });
    }
  });

  // 台本から音声生成エンドポイント
  app.post('/scripts/:id/generate-audio', async (req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    if (isGenerating) {
      res.status(409).json({ error: '生成中です。完了までお待ちください' });
      return;
    }

    const scriptId = req.params.id;
    isGenerating = true;
    logger.info({ scriptId }, '台本から音声生成を開始');

    try {
      const result = await config.pipeline.generateAudioFromScript(scriptId);
      isGenerating = false;

      if (result.success) {
        logger.info({ scriptId, episodeId: result.episodeId }, '音声生成が完了しました');
        res.json({
          success: true,
          episodeId: result.episodeId,
          audioPath: result.audioPath,
        });
      } else {
        logger.error({ error: result.error, scriptId }, '音声生成が失敗しました');
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (error) {
      isGenerating = false;
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message, scriptId }, '音声生成でエラーが発生しました');
      res.status(500).json({ success: false, error: message });
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
  <meta name="theme-color" content="#d4a574">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="apple-touch-icon" href="/images/podcast-cover.jpg">
  <title>CuraCast Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #fef9f3 0%, #f5ebe0 100%);
      color: #5c4033;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 600px; margin: 0 auto; }
    .header {
      text-align: center;
      margin-bottom: 2rem;
    }
    .cover-image {
      width: 200px;
      height: 200px;
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(92, 64, 51, 0.2);
      margin-bottom: 1rem;
      object-fit: cover;
    }
    h1 {
      font-size: 1.8rem;
      color: #8b5a2b;
      margin-bottom: 0.5rem;
    }
    .tagline {
      color: #a08060;
      font-size: 0.95rem;
    }
    .card {
      background: rgba(255, 255, 255, 0.8);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1rem;
      box-shadow: 0 2px 12px rgba(92, 64, 51, 0.08);
    }
    .card h2 { font-size: 0.9rem; color: #a08060; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; }
    .status { display: flex; align-items: center; gap: 0.5rem; }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #7cb342;
    }
    .status-dot.generating { background: #d4a574; animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .links { display: flex; flex-direction: column; gap: 0.75rem; }
    .links a {
      color: #8b5a2b;
      text-decoration: none;
      font-size: 1.1rem;
    }
    .links a:hover { text-decoration: underline; }
    button {
      background: linear-gradient(135deg, #d4a574 0%, #c4956a 100%);
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      width: 100%;
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 4px 12px rgba(212, 165, 116, 0.3);
    }
    button:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(212, 165, 116, 0.4); }
    button:disabled { background: #ccc; cursor: not-allowed; transform: none; box-shadow: none; }
    button.danger {
      background: linear-gradient(135deg, #e57373 0%, #d32f2f 100%);
      box-shadow: 0 4px 12px rgba(211, 47, 47, 0.3);
    }
    button.danger:hover { box-shadow: 0 6px 16px rgba(211, 47, 47, 0.4); }
    .btn-group { display: flex; flex-direction: column; gap: 0.5rem; }
    .btn-small {
      padding: 0.5rem 1rem;
      font-size: 0.9rem;
    }
    .stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-item {
      background: rgba(212, 165, 116, 0.1);
      padding: 0.5rem 1rem;
      border-radius: 8px;
      font-size: 0.9rem;
    }
    .stat-value { font-weight: bold; color: #8b5a2b; }
    .message {
      margin-top: 1rem;
      padding: 0.75rem;
      border-radius: 8px;
      display: none;
    }
    .message.success { background: #d4edda; color: #155724; display: block; }
    .message.error { background: #f8d7da; color: #721c24; display: block; }
    .script-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .script-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem;
      background: rgba(212, 165, 116, 0.1);
      border-radius: 8px;
      gap: 0.5rem;
    }
    .script-info { flex: 1; min-width: 0; }
    .script-title {
      font-weight: 500;
      color: #5c4033;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 0.9rem;
    }
    .script-id { font-size: 0.75rem; color: #a08060; }
    .script-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
    .script-actions button, .script-actions a {
      padding: 0.4rem 0.8rem;
      font-size: 0.8rem;
      width: auto;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .script-actions a {
      background: linear-gradient(135deg, #7cb342 0%, #689f38 100%);
      color: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(124, 179, 66, 0.3);
    }
    .empty-message { color: #a08060; font-size: 0.9rem; text-align: center; padding: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <img src="/images/podcast-cover.jpg" alt="CuraCast" class="cover-image" onerror="this.style.display='none'">
      <h1>CuraCast</h1>
      <p class="tagline">あなたに寄り添うニュースキュレーション</p>
    </div>

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

    <div class="card">
      <h2>データ統計</h2>
      <div class="stats">
        <div class="stat-item">ピックアップ済み記事: <span class="stat-value" id="processedCount">-</span></div>
        <div class="stat-item">失敗URL: <span class="stat-value" id="failedCount">-</span></div>
      </div>
    </div>

    <div class="card">
      <h2>データ管理</h2>
      <div class="btn-group">
        <button class="btn-small danger" onclick="clearData('episodes', '全エピソード')">🗑️ 全エピソードを削除</button>
        <button class="btn-small danger" onclick="clearData('processed', 'ピックアップ済み記事')">🗑️ ピックアップ済み記事をクリア</button>
        <button class="btn-small danger" onclick="clearData('failed', '失敗URL')">🗑️ 失敗URLをクリア</button>
      </div>
      <div class="message" id="clearMessage"></div>
    </div>

    <div class="card">
      <h2>台本一覧</h2>
      <div class="script-list" id="scriptList">
        <div class="empty-message">読み込み中...</div>
      </div>
      <div class="message" id="scriptMessage"></div>
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

    async function loadStats() {
      try {
        const res = await fetch('/stats');
        const data = await res.json();
        document.getElementById('processedCount').textContent = data.processedArticles;
        document.getElementById('failedCount').textContent = data.failedUrls;
      } catch {
        // エラーは無視
      }
    }

    async function clearData(type, label) {
      if (!confirm(label + 'を削除しますか？この操作は取り消せません。')) {
        return;
      }

      const msg = document.getElementById('clearMessage');
      msg.className = 'message';
      msg.style.display = 'none';

      try {
        const res = await fetch('/clear/' + type, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          let detail = '';
          if (type === 'episodes') {
            detail = '音声' + data.audioFiles + '件、台本' + data.scriptFiles + '件';
          } else {
            detail = data.cleared + '件';
          }
          msg.textContent = '✅ ' + label + 'を削除しました (' + detail + ')';
          msg.className = 'message success';
          loadStats();
        } else {
          msg.textContent = '❌ エラー: ' + data.error;
          msg.className = 'message error';
        }
      } catch (e) {
        msg.textContent = '❌ 通信エラー';
        msg.className = 'message error';
      }
    }

    async function loadScripts() {
      try {
        const res = await fetch('/scripts');
        const data = await res.json();
        const list = document.getElementById('scriptList');

        if (!data.scripts || data.scripts.length === 0) {
          list.innerHTML = '<div class="empty-message">台本がありません</div>';
          return;
        }

        list.innerHTML = data.scripts.map(script => {
          const date = new Date(script.createdAt).toLocaleDateString('ja-JP');
          const actions = script.hasAudio
            ? '<a href="/audio/' + script.id + '.mp3" target="_blank">🎧 再生</a>'
            : '<button onclick="generateAudioFromScript(\\'' + script.id + '\\')">🔊 音声生成</button>';

          return '<div class="script-item">' +
            '<div class="script-info">' +
              '<div class="script-title">' + escapeHtml(script.title) + '</div>' +
              '<div class="script-id">' + script.id + ' (' + date + ')' + (script.hasAudio ? ' ✅' : '') + '</div>' +
            '</div>' +
            '<div class="script-actions">' + actions + '</div>' +
          '</div>';
        }).join('');
      } catch {
        document.getElementById('scriptList').innerHTML = '<div class="empty-message">読み込みエラー</div>';
      }
    }

    async function generateAudioFromScript(scriptId) {
      const msg = document.getElementById('scriptMessage');
      msg.className = 'message';
      msg.style.display = 'none';

      if (!confirm('台本「' + scriptId + '」から音声を生成しますか？\\n（数分かかる場合があります）')) {
        return;
      }

      msg.textContent = '⏳ 音声生成中...';
      msg.className = 'message success';

      try {
        const res = await fetch('/scripts/' + scriptId + '/generate-audio', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          msg.textContent = '✅ 音声生成完了: ' + data.episodeId;
          msg.className = 'message success';
          loadScripts();
        } else {
          msg.textContent = '❌ エラー: ' + data.error;
          msg.className = 'message error';
        }
      } catch (e) {
        msg.textContent = '❌ 通信エラー';
        msg.className = 'message error';
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    checkStatus();
    loadStats();
    loadScripts();
    setInterval(checkStatus, 5000);
    setInterval(loadStats, 10000);
    setInterval(loadScripts, 10000);
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
