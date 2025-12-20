import express, { type Express } from 'express';
import type { RSSFeedPublisher } from './rss-feed.js';
import type { Pipeline } from '../pipeline/index.js';
import {
  getLogger,
  getLogBuffer,
  clearLogBuffer,
  subscribeToLogs,
  getSubscriberCount,
  type LogEntry,
} from '../utils/logger.js';

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

  // 台本と音声を削除するエンドポイント
  app.delete('/scripts/:id', async (req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    const scriptId = req.params.id;
    logger.info({ scriptId }, '台本削除を開始');

    try {
      const result = await config.pipeline.deleteScript(scriptId);
      logger.info({ scriptId, ...result }, '台本削除が完了しました');
      res.json({ success: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message, scriptId }, '台本削除でエラーが発生しました');
      res.status(500).json({ success: false, error: message });
    }
  });

  // 音声のみを削除するエンドポイント（台本は保持）
  app.delete('/scripts/:id/audio', async (req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    const scriptId = req.params.id;
    logger.info({ scriptId }, '音声削除を開始');

    try {
      const result = await config.pipeline.deleteAudio(scriptId);
      logger.info({ scriptId, ...result }, '音声削除が完了しました');
      res.json({ success: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message, scriptId }, '音声削除でエラーが発生しました');
      res.status(500).json({ success: false, error: message });
    }
  });

  // ログ一覧取得エンドポイント
  app.get('/logs', (_req, res) => {
    const logs = getLogBuffer();
    res.json({
      logs,
      subscriberCount: getSubscriberCount(),
    });
  });

  // ログクリアエンドポイント
  app.post('/logs/clear', (_req, res) => {
    clearLogBuffer();
    logger.info('ログバッファをクリアしました');
    res.json({ success: true });
  });

  // ログストリーミング（SSE）エンドポイント
  app.get('/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx向け

    // 接続確立メッセージ
    res.write(`data: ${JSON.stringify({ type: 'connected', time: Date.now() })}\n\n`);

    // 新しいログを受け取ったらクライアントに送信
    const unsubscribe = subscribeToLogs((log: LogEntry) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'log', ...log })}\n\n`);
      } catch {
        // 書き込みエラーは無視（クライアント切断時など）
      }
    });

    // ハートビート（30秒ごと）
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        // 書き込みエラーは無視
      }
    }, 30000);

    // クライアント切断時のクリーンアップ
    req.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  // チャンク情報取得エンドポイント
  app.get('/scripts/:id/chunks', async (req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    const scriptId = req.params.id;
    try {
      const chunks = await config.pipeline.getChunks(scriptId);
      if (!chunks) {
        res.status(404).json({ error: 'チャンク情報が見つかりません' });
        return;
      }
      res.json(chunks);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message, scriptId }, 'チャンク情報取得エラー');
      res.status(500).json({ error: message });
    }
  });

  // チャンク音声配信（静的ファイル）
  if (config.pipeline) {
    const chunksDir = config.pipeline.getChunksDir();
    app.use('/chunks', express.static(chunksDir));
  }

  // 台本全文取得エンドポイント
  app.get('/scripts/:id/content', async (req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    const scriptId = req.params.id;
    try {
      const content = await config.pipeline.getScriptContent(scriptId);
      if (!content) {
        res.status(404).json({ error: '台本が見つかりません' });
        return;
      }
      res.json({ scriptId, content });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message, scriptId }, '台本取得エラー');
      res.status(500).json({ error: message });
    }
  });

  // エピソードに紐づく記事一覧エンドポイント
  app.get('/scripts/:id/articles', (req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    const scriptId = req.params.id;
    try {
      const articles = config.pipeline.getArticlesByEpisode(scriptId);
      res.json({ scriptId, articles, count: articles.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message, scriptId }, 'エピソード記事取得エラー');
      res.status(500).json({ error: message });
    }
  });

  // ピックアップ済み記事一覧エンドポイント
  app.get('/articles', (_req, res) => {
    if (!config.pipeline) {
      res.status(503).json({ error: 'パイプラインが設定されていません' });
      return;
    }

    try {
      const articles = config.pipeline.getProcessedArticles();
      res.json({ articles });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message }, '記事一覧取得エラー');
      res.status(500).json({ error: message });
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
    button.btn-secondary {
      background: linear-gradient(135deg, #78909c 0%, #546e7a 100%);
      box-shadow: 0 4px 12px rgba(84, 110, 122, 0.3);
    }
    button.btn-secondary:hover { box-shadow: 0 6px 16px rgba(84, 110, 122, 0.4); }
    button.btn-danger {
      background: linear-gradient(135deg, #e57373 0%, #d32f2f 100%);
      box-shadow: 0 4px 12px rgba(211, 47, 47, 0.3);
      padding: 0.4rem 0.6rem;
    }
    button.btn-danger:hover { box-shadow: 0 6px 16px rgba(211, 47, 47, 0.4); }
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
    .script-actions { display: flex; gap: 0.5rem; flex-shrink: 0; align-items: center; }
    .script-actions button, .script-actions a {
      padding: 0.4rem 0.8rem;
      font-size: 0.8rem;
      width: auto;
      text-decoration: none;
      display: inline-flex;
    }
    /* ドロップダウンメニュー */
    .dropdown {
      position: relative;
      display: inline-block;
    }
    .dropdown-toggle {
      background: linear-gradient(135deg, #9e9e9e 0%, #757575 100%);
      color: white;
      border: none;
      border-radius: 8px;
      padding: 0.4rem 0.6rem;
      font-size: 1rem;
      cursor: pointer;
      min-width: 32px;
    }
    .dropdown-toggle:hover {
      background: linear-gradient(135deg, #757575 0%, #616161 100%);
    }
    .dropdown-menu {
      display: none;
      position: absolute;
      right: 0;
      top: 100%;
      background: white;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
      min-width: 160px;
      z-index: 100;
      overflow: hidden;
      margin-top: 4px;
    }
    .dropdown-menu.show { display: block; }
    .dropdown-menu button, .dropdown-menu a {
      display: block;
      width: 100%;
      padding: 0.6rem 1rem;
      text-align: left;
      background: none;
      border: none;
      border-radius: 0;
      color: #5c4033;
      font-size: 0.85rem;
      cursor: pointer;
      text-decoration: none;
      box-shadow: none;
    }
    .dropdown-menu button:hover, .dropdown-menu a:hover {
      background: #f5ebe0;
      transform: none;
      box-shadow: none;
    }
    .dropdown-menu .danger { color: #d32f2f; }
    .dropdown-menu .danger:hover { background: #ffebee; }
    .script-actions a {
      background: linear-gradient(135deg, #7cb342 0%, #689f38 100%);
      color: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(124, 179, 66, 0.3);
    }
    .empty-message { color: #a08060; font-size: 0.9rem; text-align: center; padding: 1rem; }
    /* ログビューア */
    .log-controls { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem; }
    .log-filters { display: flex; gap: 0.25rem; flex-wrap: wrap; }
    .log-filter {
      padding: 0.3rem 0.6rem;
      border: 1px solid #d4a574;
      border-radius: 4px;
      background: white;
      color: #8b5a2b;
      cursor: pointer;
      font-size: 0.8rem;
      transition: all 0.2s;
    }
    .log-filter.active { background: #d4a574; color: white; }
    .log-filter:hover { background: #f5ebe0; }
    .log-filter.active:hover { background: #c4956a; }
    .log-search {
      flex: 1;
      min-width: 150px;
      padding: 0.4rem 0.6rem;
      border: 1px solid #d4a574;
      border-radius: 4px;
      font-size: 0.85rem;
      outline: none;
    }
    .log-search:focus { border-color: #8b5a2b; box-shadow: 0 0 0 2px rgba(139, 90, 43, 0.1); }
    .log-viewer {
      background: #1e1e1e;
      border-radius: 8px;
      padding: 0.75rem;
      height: 300px;
      overflow-y: auto;
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
      font-size: 0.75rem;
      line-height: 1.4;
    }
    .log-entry { padding: 0.2rem 0; border-bottom: 1px solid #333; }
    .log-entry:last-child { border-bottom: none; }
    .log-time { color: #888; margin-right: 0.5rem; }
    .log-level { padding: 0.1rem 0.3rem; border-radius: 3px; margin-right: 0.5rem; font-weight: bold; font-size: 0.7rem; }
    .log-level.debug { background: #4a4a4a; color: #aaa; }
    .log-level.info { background: #2d5a2d; color: #7cb342; }
    .log-level.warn { background: #5a4a2d; color: #ffc107; }
    .log-level.error { background: #5a2d2d; color: #f44336; }
    .log-msg { color: #e0e0e0; word-break: break-all; }
    .log-meta { color: #888; font-size: 0.7rem; margin-left: 0.5rem; }
    .log-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .log-status { font-size: 0.8rem; color: #a08060; display: flex; align-items: center; gap: 0.5rem; }
    .log-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #7cb342; }
    .log-status-dot.disconnected { background: #f44336; }
    .auto-scroll-toggle {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.8rem;
      color: #a08060;
      cursor: pointer;
    }
    .auto-scroll-toggle input { cursor: pointer; }
    /* チャンクモーダル */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      z-index: 1000;
      justify-content: center;
      align-items: center;
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: white;
      border-radius: 12px;
      max-width: 90%;
      max-height: 90%;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }
    .modal-header {
      padding: 1rem;
      background: linear-gradient(135deg, #d4a574 0%, #c4956a 100%);
      color: white;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-header h3 { margin: 0; font-size: 1rem; }
    .modal-close {
      background: none;
      border: none;
      color: white;
      font-size: 1.5rem;
      cursor: pointer;
      padding: 0;
      width: auto;
      box-shadow: none;
    }
    .modal-close:hover { opacity: 0.8; transform: none; }
    .modal-body {
      padding: 1rem;
      overflow-y: auto;
      max-height: 70vh;
    }
    .chunk-list { display: flex; flex-direction: column; gap: 1rem; }
    .chunk-item {
      border: 1px solid #e0d5c8;
      border-radius: 8px;
      padding: 0.75rem;
      background: #fef9f3;
    }
    .chunk-item.warning {
      border-color: #ffc107;
      background: #fff8e1;
    }
    .chunk-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
    }
    .chunk-index { font-weight: bold; color: #8b5a2b; }
    .chunk-size { font-size: 0.8rem; color: #a08060; }
    .chunk-size.warning { color: #d32f2f; font-weight: bold; }
    .chunk-text {
      background: #1e1e1e;
      color: #e0e0e0;
      padding: 0.5rem;
      border-radius: 4px;
      font-size: 0.8rem;
      line-height: 1.5;
      max-height: 150px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    }
    .chunk-audio {
      margin-top: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .chunk-audio audio { flex: 1; height: 32px; }
    .btn-chunks {
      background: linear-gradient(135deg, #9c27b0 0%, #7b1fa2 100%);
      box-shadow: 0 2px 8px rgba(156, 39, 176, 0.3);
    }
    .btn-chunks:hover { box-shadow: 0 4px 12px rgba(156, 39, 176, 0.4); }
    .btn-script {
      background: linear-gradient(135deg, #2196f3 0%, #1976d2 100%);
      box-shadow: 0 2px 8px rgba(33, 150, 243, 0.3);
    }
    .btn-script:hover { box-shadow: 0 4px 12px rgba(33, 150, 243, 0.4); }
    .btn-articles {
      background: linear-gradient(135deg, #ff9800 0%, #f57c00 100%);
      box-shadow: 0 2px 8px rgba(255, 152, 0, 0.3);
    }
    .btn-articles:hover { box-shadow: 0 4px 12px rgba(255, 152, 0, 0.4); }
    /* 記事一覧 */
    .article-list { display: flex; flex-direction: column; gap: 0.5rem; max-height: 300px; overflow-y: auto; }
    .article-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem;
      background: rgba(212, 165, 116, 0.1);
      border-radius: 6px;
      gap: 0.5rem;
    }
    .article-info { flex: 1; min-width: 0; }
    .article-title {
      font-size: 0.85rem;
      color: #5c4033;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .article-meta { font-size: 0.7rem; color: #a08060; }
    .article-link {
      color: #8b5a2b;
      text-decoration: none;
      font-size: 0.8rem;
      flex-shrink: 0;
    }
    .article-link:hover { text-decoration: underline; }
    /* 台本モーダル */
    .script-content {
      background: #fef9f3;
      padding: 1rem;
      border-radius: 8px;
      white-space: pre-wrap;
      font-size: 0.9rem;
      line-height: 1.8;
      max-height: 60vh;
      overflow-y: auto;
    }
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

    <div class="card">
      <h2>ピックアップ済み記事</h2>
      <div class="article-list" id="articleList">
        <div class="empty-message">読み込み中...</div>
      </div>
    </div>

    <div class="card">
      <h2>実行ログ</h2>
      <div class="log-controls">
        <div class="log-filters">
          <button class="log-filter active" data-level="all">ALL</button>
          <button class="log-filter active" data-level="debug">DEBUG</button>
          <button class="log-filter active" data-level="info">INFO</button>
          <button class="log-filter active" data-level="warn">WARN</button>
          <button class="log-filter active" data-level="error">ERROR</button>
        </div>
        <input type="text" class="log-search" id="logSearch" placeholder="検索...">
      </div>
      <div class="log-viewer" id="logViewer">
        <div class="empty-message">ログを読み込み中...</div>
      </div>
      <div class="log-actions">
        <div class="log-status">
          <span class="log-status-dot" id="logStatusDot"></span>
          <span id="logStatusText">接続中...</span>
        </div>
        <label class="auto-scroll-toggle">
          <input type="checkbox" id="autoScroll" checked>
          自動スクロール
        </label>
        <button class="btn-small btn-secondary" onclick="clearLogs()">クリア</button>
      </div>
    </div>
    ` : ''}
  </div>

  <script>
    let isGenerating = false;

    async function checkStatus() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        const dot = document.getElementById('statusDot');
        const text = document.getElementById('statusText');
        isGenerating = data.generating;

        if (data.generating) {
          dot.classList.add('generating');
          text.textContent = '生成中...';
        } else {
          dot.classList.remove('generating');
          text.textContent = '正常';
        }

        // 生成ボタンの状態を更新
        updateGenerateButtons();
      } catch {
        document.getElementById('statusText').textContent = 'エラー';
      }
    }

    function updateGenerateButtons() {
      // エピソード生成ボタン
      const generateBtn = document.getElementById('generateBtn');
      if (generateBtn) {
        generateBtn.disabled = isGenerating;
        if (isGenerating && generateBtn.textContent !== '⏳ 生成中...') {
          generateBtn.textContent = '⏳ 生成中...';
        } else if (!isGenerating && generateBtn.textContent === '⏳ 生成中...') {
          generateBtn.textContent = '🎬 今すぐ生成';
        }
      }

      // 台本一覧の音声生成ボタン
      const scriptButtons = document.querySelectorAll('.script-actions button');
      scriptButtons.forEach(btn => {
        btn.disabled = isGenerating;
      });
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
          const escapedTitle = escapeHtml(script.title).replace(/'/g, "\\'");

          // 主要アクション
          let mainActions = '<button class="btn-script" onclick="showScript(\\'' + script.id + '\\')">📝 台本</button>';
          if (script.hasAudio) {
            mainActions += '<a href="/audio/' + script.id + '.mp3" target="_blank">🎧 再生</a>';
          } else {
            mainActions += '<button onclick="generateAudioFromScript(\\'' + script.id + '\\')">🔊 音声生成</button>';
          }

          // ドロップダウンメニュー
          let dropdownItems = '<button onclick="showEpisodeArticles(\\'' + script.id + '\\', \\'' + escapedTitle + '\\'); closeDropdowns();">📰 記事一覧</button>';
          if (script.hasAudio) {
            dropdownItems += '<button onclick="showChunks(\\'' + script.id + '\\'); closeDropdowns();">📊 チャンク詳細</button>' +
              '<button onclick="deleteAudio(\\'' + script.id + '\\'); closeDropdowns();">🔄 音声を再生成</button>';
          }
          dropdownItems += '<button class="danger" onclick="deleteScript(\\'' + script.id + '\\'); closeDropdowns();">🗑️ 削除</button>';

          return '<div class="script-item">' +
            '<div class="script-info">' +
              '<div class="script-title">' + escapeHtml(script.title) + '</div>' +
              '<div class="script-id">' + script.id + ' (' + date + ')' + (script.hasAudio ? ' ✅' : '') + '</div>' +
            '</div>' +
            '<div class="script-actions">' + mainActions +
              '<div class="dropdown">' +
                '<button class="dropdown-toggle" onclick="toggleDropdown(this)">⋮</button>' +
                '<div class="dropdown-menu">' + dropdownItems + '</div>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        // 生成中の場合はボタンを無効化
        updateGenerateButtons();
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

    async function deleteScript(scriptId) {
      const msg = document.getElementById('scriptMessage');
      msg.className = 'message';
      msg.style.display = 'none';

      if (!confirm('台本「' + scriptId + '」を削除しますか？\\n（音声も削除されます。この操作は取り消せません）')) {
        return;
      }

      try {
        const res = await fetch('/scripts/' + scriptId, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          msg.textContent = '✅ 削除完了';
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

    async function deleteAudio(scriptId) {
      const msg = document.getElementById('scriptMessage');
      msg.className = 'message';
      msg.style.display = 'none';

      if (!confirm('音声を削除して再生成しますか？\\n（数分かかる場合があります）')) {
        return;
      }

      msg.textContent = '⏳ 音声を削除して再生成中...';
      msg.className = 'message success';

      try {
        // 音声を削除
        const deleteRes = await fetch('/scripts/' + scriptId + '/audio', { method: 'DELETE' });
        const deleteData = await deleteRes.json();
        if (!deleteData.success) {
          msg.textContent = '❌ 削除エラー: ' + deleteData.error;
          msg.className = 'message error';
          return;
        }

        // 音声を再生成
        const genRes = await fetch('/scripts/' + scriptId + '/generate-audio', { method: 'POST' });
        const genData = await genRes.json();
        if (genData.success) {
          msg.textContent = '✅ 再生成完了: ' + genData.episodeId;
          msg.className = 'message success';
          loadScripts();
        } else {
          msg.textContent = '❌ 生成エラー: ' + genData.error;
          msg.className = 'message error';
          loadScripts();
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

    // ドロップダウンメニュー制御
    function toggleDropdown(button) {
      const menu = button.nextElementSibling;
      const isOpen = menu.classList.contains('show');
      closeDropdowns();
      if (!isOpen) {
        menu.classList.add('show');
      }
    }

    function closeDropdowns() {
      document.querySelectorAll('.dropdown-menu.show').forEach(menu => {
        menu.classList.remove('show');
      });
    }

    // 画面のどこかをクリックしたらドロップダウンを閉じる
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.dropdown')) {
        closeDropdowns();
      }
    });

    // ログビューア機能
    let logEntries = [];
    let eventSource = null;
    let activeFilters = new Set(['debug', 'info', 'warn', 'error']);
    let searchQuery = '';

    function formatLogTime(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('ja-JP', { hour12: false });
    }

    function formatLogMeta(log) {
      const meta = [];
      for (const [key, value] of Object.entries(log)) {
        if (['level', 'levelLabel', 'time', 'msg', 'type'].includes(key)) continue;
        if (typeof value === 'object') {
          meta.push(key + '=' + JSON.stringify(value));
        } else {
          meta.push(key + '=' + value);
        }
      }
      return meta.length > 0 ? ' ' + meta.join(' ') : '';
    }

    function createLogEntryHtml(log) {
      const time = formatLogTime(log.time);
      const level = log.levelLabel || 'info';
      const msg = escapeHtml(log.msg || '');
      const meta = escapeHtml(formatLogMeta(log));
      return '<div class="log-entry" data-level="' + level + '">' +
        '<span class="log-time">' + time + '</span>' +
        '<span class="log-level ' + level + '">' + level.toUpperCase() + '</span>' +
        '<span class="log-msg">' + msg + '</span>' +
        (meta ? '<span class="log-meta">' + meta + '</span>' : '') +
        '</div>';
    }

    function renderLogs() {
      const viewer = document.getElementById('logViewer');
      const filtered = logEntries.filter(log => {
        // レベルフィルター
        const level = log.levelLabel || 'info';
        if (!activeFilters.has(level)) return false;
        // 検索フィルター
        if (searchQuery) {
          const text = (log.msg || '') + formatLogMeta(log);
          if (!text.toLowerCase().includes(searchQuery.toLowerCase())) return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        viewer.innerHTML = '<div class="empty-message">ログがありません</div>';
        return;
      }

      viewer.innerHTML = filtered.map(createLogEntryHtml).join('');

      // 自動スクロール
      if (document.getElementById('autoScroll').checked) {
        viewer.scrollTop = viewer.scrollHeight;
      }
    }

    function addLogEntry(log) {
      logEntries.push(log);
      // 最大500件に制限
      if (logEntries.length > 500) {
        logEntries.shift();
      }
      renderLogs();
    }

    async function loadExistingLogs() {
      try {
        const res = await fetch('/logs');
        const data = await res.json();
        logEntries = data.logs || [];
        renderLogs();
      } catch {
        document.getElementById('logViewer').innerHTML = '<div class="empty-message">ログの読み込みに失敗しました</div>';
      }
    }

    function connectLogStream() {
      const statusDot = document.getElementById('logStatusDot');
      const statusText = document.getElementById('logStatusText');

      if (eventSource) {
        eventSource.close();
      }

      eventSource = new EventSource('/logs/stream');

      eventSource.onopen = function() {
        statusDot.classList.remove('disconnected');
        statusText.textContent = '接続中';
      };

      eventSource.onmessage = function(e) {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'connected') {
            // 接続確立
            return;
          }
          if (data.type === 'log') {
            addLogEntry(data);
          }
        } catch {
          // パースエラーは無視
        }
      };

      eventSource.onerror = function() {
        statusDot.classList.add('disconnected');
        statusText.textContent = '切断（再接続中...）';
        // 自動再接続はEventSourceが行う
      };
    }

    async function clearLogs() {
      if (!confirm('ログをクリアしますか？')) return;
      try {
        await fetch('/logs/clear', { method: 'POST' });
        logEntries = [];
        renderLogs();
      } catch {
        alert('ログのクリアに失敗しました');
      }
    }

    // 初期化
    if (document.getElementById('logViewer')) {
      loadExistingLogs();
      connectLogStream();

      // フィルターボタンのイベント
      document.querySelectorAll('.log-filter').forEach(btn => {
        btn.addEventListener('click', function() {
          const level = this.dataset.level;
          if (level === 'all') {
            const allActive = activeFilters.size === 4;
            if (allActive) {
              activeFilters.clear();
              document.querySelectorAll('.log-filter').forEach(b => b.classList.remove('active'));
            } else {
              activeFilters = new Set(['debug', 'info', 'warn', 'error']);
              document.querySelectorAll('.log-filter').forEach(b => b.classList.add('active'));
            }
          } else {
            if (activeFilters.has(level)) {
              activeFilters.delete(level);
              this.classList.remove('active');
            } else {
              activeFilters.add(level);
              this.classList.add('active');
            }
            const allBtn = document.querySelector('.log-filter[data-level="all"]');
            if (activeFilters.size === 4) {
              allBtn.classList.add('active');
            } else {
              allBtn.classList.remove('active');
            }
          }
          renderLogs();
        });
      });

      // 検索フィールドのイベント
      document.getElementById('logSearch').addEventListener('input', function() {
        searchQuery = this.value;
        renderLogs();
      });
    }

    // チャンクモーダル関連
    async function showChunks(scriptId) {
      const modal = document.getElementById('chunkModal');
      const title = document.getElementById('chunkModalTitle');
      const body = document.getElementById('chunkModalBody');

      title.textContent = 'チャンク情報を読み込み中...';
      body.innerHTML = '<div class="empty-message">読み込み中...</div>';
      modal.classList.add('active');

      try {
        const res = await fetch('/scripts/' + scriptId + '/chunks');
        if (!res.ok) {
          if (res.status === 404) {
            body.innerHTML = '<div class="empty-message">チャンク情報がありません（音声生成前または古いエピソード）</div>';
            title.textContent = 'チャンク情報なし';
            return;
          }
          throw new Error('取得失敗');
        }
        const data = await res.json();
        title.textContent = data.scriptTitle + ' (' + data.totalChunks + 'チャンク)';

        if (!data.chunks || data.chunks.length === 0) {
          body.innerHTML = '<div class="empty-message">チャンクがありません</div>';
          return;
        }

        body.innerHTML = '<div class="chunk-list">' + data.chunks.map(chunk => {
          const warningClass = chunk.isSmall ? ' warning' : '';
          const sizeClass = chunk.isSmall ? ' warning' : '';
          return '<div class="chunk-item' + warningClass + '">' +
            '<div class="chunk-header">' +
              '<span class="chunk-index">チャンク ' + chunk.index + '</span>' +
              '<span class="chunk-size' + sizeClass + '">' +
                (chunk.isSmall ? '⚠️ ' : '') + chunk.audioSize.toLocaleString() + ' bytes' +
              '</span>' +
            '</div>' +
            '<div class="chunk-text">' + escapeHtml(chunk.text) + '</div>' +
            '<div class="chunk-audio">' +
              '<audio controls preload="none" src="/chunks/' + scriptId + '/' + chunk.audioFile + '"></audio>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';
      } catch (e) {
        body.innerHTML = '<div class="empty-message">読み込みエラー</div>';
        title.textContent = 'エラー';
      }
    }

    function closeChunkModal() {
      document.getElementById('chunkModal').classList.remove('active');
      // 再生中の音声を停止
      document.querySelectorAll('#chunkModalBody audio').forEach(a => {
        a.pause();
        a.currentTime = 0;
      });
    }

    // モーダル外クリックで閉じる
    document.getElementById('chunkModal')?.addEventListener('click', function(e) {
      if (e.target === this) closeChunkModal();
    });

    // 台本モーダル関連
    async function showScript(scriptId) {
      const modal = document.getElementById('scriptModal');
      const title = document.getElementById('scriptModalTitle');
      const body = document.getElementById('scriptModalBody');

      title.textContent = '台本を読み込み中...';
      body.innerHTML = '<div class="empty-message">読み込み中...</div>';
      modal.classList.add('active');

      try {
        const res = await fetch('/scripts/' + scriptId + '/content');
        if (!res.ok) {
          if (res.status === 404) {
            body.innerHTML = '<div class="empty-message">台本が見つかりません</div>';
            title.textContent = 'エラー';
            return;
          }
          throw new Error('取得失敗');
        }
        const data = await res.json();
        title.textContent = '台本: ' + scriptId;
        body.innerHTML = '<div class="script-content">' + escapeHtml(data.content) + '</div>';
      } catch (e) {
        body.innerHTML = '<div class="empty-message">読み込みエラー</div>';
        title.textContent = 'エラー';
      }
    }

    function closeScriptModal() {
      document.getElementById('scriptModal').classList.remove('active');
    }

    // モーダル外クリックで閉じる
    document.getElementById('scriptModal')?.addEventListener('click', function(e) {
      if (e.target === this) closeScriptModal();
    });

    // エピソード記事一覧モーダル関連
    async function showEpisodeArticles(scriptId, scriptTitle) {
      const modal = document.getElementById('episodeArticlesModal');
      const title = document.getElementById('episodeArticlesModalTitle');
      const body = document.getElementById('episodeArticlesModalBody');

      title.textContent = '読み込み中...';
      body.innerHTML = '<div class="empty-message">読み込み中...</div>';
      modal.classList.add('active');

      try {
        const res = await fetch('/scripts/' + scriptId + '/articles');
        if (!res.ok) {
          throw new Error('取得失敗');
        }
        const data = await res.json();
        title.textContent = scriptTitle + ' (' + data.count + '件)';

        if (!data.articles || data.articles.length === 0) {
          body.innerHTML = '<div class="empty-message">この台本に紐づく記事がありません</div>';
          return;
        }

        body.innerHTML = '<div class="article-list" style="max-height: none;">' + data.articles.map(article => {
          const date = new Date(article.processedAt).toLocaleDateString('ja-JP');
          return '<div class="article-item">' +
            '<div class="article-info">' +
              '<div class="article-title">' + escapeHtml(article.title) + '</div>' +
              '<div class="article-meta">' + date + '</div>' +
            '</div>' +
            '<a class="article-link" href="' + escapeHtml(article.url) + '" target="_blank">🔗 元記事</a>' +
          '</div>';
        }).join('') + '</div>';
      } catch (e) {
        body.innerHTML = '<div class="empty-message">読み込みエラー</div>';
        title.textContent = 'エラー';
      }
    }

    function closeEpisodeArticlesModal() {
      document.getElementById('episodeArticlesModal').classList.remove('active');
    }

    // モーダル外クリックで閉じる
    document.getElementById('episodeArticlesModal')?.addEventListener('click', function(e) {
      if (e.target === this) closeEpisodeArticlesModal();
    });

    // 記事一覧読み込み
    async function loadArticles() {
      const list = document.getElementById('articleList');
      if (!list) return;

      try {
        const res = await fetch('/articles');
        const data = await res.json();

        if (!data.articles || data.articles.length === 0) {
          list.innerHTML = '<div class="empty-message">ピックアップ済み記事がありません</div>';
          return;
        }

        // 最新20件のみ表示
        const articles = data.articles.slice(0, 20);
        list.innerHTML = articles.map(article => {
          const date = new Date(article.processedAt).toLocaleDateString('ja-JP');
          return '<div class="article-item">' +
            '<div class="article-info">' +
              '<div class="article-title">' + escapeHtml(article.title) + '</div>' +
              '<div class="article-meta">' + date + (article.episodeId ? ' / ' + article.episodeId : '') + '</div>' +
            '</div>' +
            '<a class="article-link" href="' + escapeHtml(article.url) + '" target="_blank">🔗 元記事</a>' +
          '</div>';
        }).join('');
      } catch {
        list.innerHTML = '<div class="empty-message">読み込みエラー</div>';
      }
    }

    checkStatus();
    loadStats();
    loadScripts();
    loadArticles();
    setInterval(checkStatus, 5000);
    setInterval(loadStats, 10000);
    setInterval(loadScripts, 10000);
    setInterval(loadArticles, 30000);
  </script>

  <!-- チャンクモーダル -->
  <div class="modal-overlay" id="chunkModal">
    <div class="modal">
      <div class="modal-header">
        <h3 id="chunkModalTitle">チャンク情報</h3>
        <button class="modal-close" onclick="closeChunkModal()">&times;</button>
      </div>
      <div class="modal-body" id="chunkModalBody">
        <div class="empty-message">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- 台本モーダル -->
  <div class="modal-overlay" id="scriptModal">
    <div class="modal" style="width: 90%; max-width: 800px;">
      <div class="modal-header">
        <h3 id="scriptModalTitle">台本</h3>
        <button class="modal-close" onclick="closeScriptModal()">&times;</button>
      </div>
      <div class="modal-body" id="scriptModalBody">
        <div class="empty-message">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- エピソード記事一覧モーダル -->
  <div class="modal-overlay" id="episodeArticlesModal">
    <div class="modal" style="width: 90%; max-width: 600px;">
      <div class="modal-header">
        <h3 id="episodeArticlesModalTitle">ピックアップ記事</h3>
        <button class="modal-close" onclick="closeEpisodeArticlesModal()">&times;</button>
      </div>
      <div class="modal-body" id="episodeArticlesModalBody">
        <div class="empty-message">読み込み中...</div>
      </div>
    </div>
  </div>
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
