import 'dotenv/config';
import { loadConfig, loadProfile } from './config/index.js';
import { Pipeline } from './pipeline/index.js';
import { Scheduler } from './pipeline/scheduler.js';
import { createServer, startServer } from './publishers/server.js';
import { createLogger, getLogger } from './utils/logger.js';

async function main(): Promise<void> {
  // コマンドライン引数を解析
  const args = process.argv.slice(2);
  const configPath = args.find((a) => a.startsWith('--config='))?.split('=')[1];
  const profilePath = args.find((a) => a.startsWith('--profile='))?.split('=')[1];
  const modeOverride = args.find((a) => a.startsWith('--mode='))?.split('=')[1] as 'batch' | 'once' | undefined;

  // 設定を読み込み
  const config = loadConfig(configPath);
  const profile = loadProfile(profilePath);

  // ロガーを初期化
  createLogger(config.logging.level);
  const logger = getLogger();

  logger.info({ mode: modeOverride ?? config.mode }, 'CuraCastを起動します');

  // パイプラインを初期化
  const pipeline = new Pipeline(config, profile);
  await pipeline.initialize();

  const mode = modeOverride ?? config.mode;

  if (mode === 'once') {
    // 1回実行モード
    logger.info('1回実行モードで起動');
    const result = await pipeline.run();
    if (result.success) {
      logger.info(
        { episodeId: result.episodeId, episodeTitle: result.episodeTitle, articleCount: result.articleCount },
        '実行完了'
      );
    } else {
      logger.error({ error: result.error }, '実行失敗');
      process.exit(1);
    }
    return;
  }

  // サーバーを起動
  const app = createServer({
    port: config.server.port,
    audioDir: config.output.audioDir,
    feedPublisher: pipeline.getFeedPublisher(),
  });
  await startServer(app, config.server.port);

  if (mode === 'batch') {
    // 定期実行モード
    logger.info({ cron: config.schedule.cron }, 'バッチモードで起動');

    const scheduler = new Scheduler(pipeline, {
      cron: config.schedule.cron,
      timezone: config.schedule.timezone,
    });
    scheduler.start();

    // 起動時に1回実行するオプション
    if (args.includes('--run-now')) {
      logger.info('起動時に即座に実行します');
      const result = await pipeline.run();
      if (result.success) {
        logger.info({ episodeId: result.episodeId, articleCount: result.articleCount }, '初回実行完了');
      } else {
        logger.error({ error: result.error }, '初回実行失敗');
      }
    }

    // シグナルハンドリング
    const shutdown = () => {
      logger.info('シャットダウンを開始します');
      scheduler.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else if (mode === 'watch') {
    // ファイル監視モード（将来の拡張用）
    logger.info('ウォッチモードは現在サポートされていません');
    logger.info('代わりにサーバーのみを起動します');
  }

  logger.info(`サーバーが起動しました: http://localhost:${config.server.port}`);
  logger.info(`RSSフィード: http://localhost:${config.server.port}/feed.xml`);
}

main().catch((error) => {
  console.error('起動エラー:', error);
  process.exit(1);
});
