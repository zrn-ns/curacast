import fs from 'fs/promises';
import path from 'path';
import { getLogger } from '../utils/logger.js';

export interface ProcessedArticle {
  id: string;
  url: string;
  title: string;
  processedAt: string;
  episodeId?: string;
}

export interface FailedUrl {
  url: string;
  error: string;
  failedAt: string;
  failureCount: number;
}

export interface StorageData {
  processedArticles: ProcessedArticle[];
  failedUrls: FailedUrl[];
}

export class JsonStorage {
  private filePath: string;
  private data: StorageData;
  private logger = getLogger();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'processed.json');
    this.data = { processedArticles: [], failedUrls: [] };
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as Partial<StorageData>;
      // 古いデータ形式との互換性を保つ
      this.data = {
        processedArticles: parsed.processedArticles ?? [],
        failedUrls: parsed.failedUrls ?? [],
      };
      this.logger.debug({ count: this.data.processedArticles.length }, '処理済み記事データを読み込み');
    } catch (error) {
      // ファイルが存在しない場合は空のデータで初期化
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = { processedArticles: [], failedUrls: [] };
        this.logger.debug('処理済み記事データファイルが存在しないため、新規作成');
      } else {
        throw error;
      }
    }
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    this.logger.debug({ path: this.filePath }, '処理済み記事データを保存');
  }

  isProcessed(articleId: string): boolean {
    return this.data.processedArticles.some((a) => a.id === articleId);
  }

  async markAsProcessed(article: { id: string; url: string; title: string }, episodeId?: string): Promise<void> {
    if (this.isProcessed(article.id)) {
      return;
    }

    this.data.processedArticles.push({
      id: article.id,
      url: article.url,
      title: article.title,
      processedAt: new Date().toISOString(),
      episodeId,
    });

    await this.save();
    this.logger.debug({ articleId: article.id, title: article.title }, '記事を処理済みとしてマーク');
  }

  getProcessedIds(): string[] {
    return this.data.processedArticles.map((a) => a.id);
  }

  getProcessedCount(): number {
    return this.data.processedArticles.length;
  }

  // 古い処理済み記事を削除（保持期間を過ぎたもの）
  async cleanup(retentionDays: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const before = this.data.processedArticles.length;
    this.data.processedArticles = this.data.processedArticles.filter((a) => {
      const processedAt = new Date(a.processedAt);
      return processedAt >= cutoffDate;
    });
    const removed = before - this.data.processedArticles.length;

    if (removed > 0) {
      await this.save();
      this.logger.info({ removed, retentionDays }, '古い処理済み記事を削除');
    }

    return removed;
  }

  // URLを失敗としてマーク
  async markUrlAsFailed(url: string, error: string): Promise<void> {
    const existing = this.data.failedUrls.find((f) => f.url === url);

    if (existing) {
      // 既存のエントリを更新
      existing.error = error;
      existing.failedAt = new Date().toISOString();
      existing.failureCount += 1;
    } else {
      // 新規追加
      this.data.failedUrls.push({
        url,
        error,
        failedAt: new Date().toISOString(),
        failureCount: 1,
      });
    }

    await this.save();
    this.logger.debug({ url, error }, 'URLを失敗としてマーク');
  }

  // URLが失敗リストに含まれているか確認（保持期間内のみ）
  isUrlFailed(url: string, retentionDays: number = 7): boolean {
    const entry = this.data.failedUrls.find((f) => f.url === url);
    if (!entry) {
      return false;
    }

    // 保持期間を過ぎていれば再試行可能
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const failedAt = new Date(entry.failedAt);

    return failedAt >= cutoffDate;
  }

  // 失敗URLリストを取得
  getFailedUrls(): FailedUrl[] {
    return this.data.failedUrls;
  }

  // 古い失敗URLをクリーンアップ
  async cleanupFailedUrls(retentionDays: number = 7): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const before = this.data.failedUrls.length;
    this.data.failedUrls = this.data.failedUrls.filter((f) => {
      const failedAt = new Date(f.failedAt);
      return failedAt >= cutoffDate;
    });
    const removed = before - this.data.failedUrls.length;

    if (removed > 0) {
      await this.save();
      this.logger.info({ removed, retentionDays }, '古い失敗URLを削除');
    }

    return removed;
  }

  // 処理済み記事を全てクリア
  async clearProcessedArticles(): Promise<number> {
    const count = this.data.processedArticles.length;
    this.data.processedArticles = [];
    await this.save();
    this.logger.info({ cleared: count }, '処理済み記事を全てクリア');
    return count;
  }

  // 失敗URLを全てクリア
  async clearFailedUrls(): Promise<number> {
    const count = this.data.failedUrls.length;
    this.data.failedUrls = [];
    await this.save();
    this.logger.info({ cleared: count }, '失敗URLを全てクリア');
    return count;
  }

  // 全データをクリア
  async clearAll(): Promise<{ processedArticles: number; failedUrls: number }> {
    const processedCount = this.data.processedArticles.length;
    const failedCount = this.data.failedUrls.length;
    this.data = { processedArticles: [], failedUrls: [] };
    await this.save();
    this.logger.info({ processedArticles: processedCount, failedUrls: failedCount }, '全データをクリア');
    return { processedArticles: processedCount, failedUrls: failedCount };
  }
}
