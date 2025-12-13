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

export interface StorageData {
  processedArticles: ProcessedArticle[];
}

export class JsonStorage {
  private filePath: string;
  private data: StorageData;
  private logger = getLogger();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'processed.json');
    this.data = { processedArticles: [] };
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.data = JSON.parse(content) as StorageData;
      this.logger.debug({ count: this.data.processedArticles.length }, '処理済み記事データを読み込み');
    } catch (error) {
      // ファイルが存在しない場合は空のデータで初期化
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = { processedArticles: [] };
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
}
