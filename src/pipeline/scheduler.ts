import cron from 'node-cron';
import type { Pipeline } from './index.js';
import { getLogger } from '../utils/logger.js';

export interface SchedulerConfig {
  cron: string;
  timezone: string;
}

export class Scheduler {
  private pipeline: Pipeline;
  private config: SchedulerConfig;
  private task: cron.ScheduledTask | null = null;
  private logger = getLogger();

  constructor(pipeline: Pipeline, config: SchedulerConfig) {
    this.pipeline = pipeline;
    this.config = config;
  }

  start(): void {
    if (this.task) {
      this.logger.warn('スケジューラーは既に開始されています');
      return;
    }

    // cron式のバリデーション
    if (!cron.validate(this.config.cron)) {
      throw new Error(`無効なcron式です: ${this.config.cron}`);
    }

    this.task = cron.schedule(
      this.config.cron,
      async () => {
        this.logger.info({ cron: this.config.cron }, 'スケジュールされたパイプライン実行を開始');
        const result = await this.pipeline.run();
        if (result.success) {
          this.logger.info(
            { episodeId: result.episodeId, articleCount: result.articleCount },
            'スケジュール実行が完了しました'
          );
        } else {
          this.logger.error({ error: result.error }, 'スケジュール実行が失敗しました');
        }
      },
      {
        timezone: this.config.timezone,
        scheduled: true,
      }
    );

    this.logger.info(
      { cron: this.config.cron, timezone: this.config.timezone },
      'スケジューラーを開始しました'
    );
  }

  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      this.logger.info('スケジューラーを停止しました');
    }
  }

  // 次の実行時間を取得
  getNextRun(): Date | null {
    // node-cronは次の実行時間を直接取得するAPIを持っていないため、
    // cronパターンから計算する必要があります
    // ここでは簡略化のためnullを返します
    return null;
  }
}
