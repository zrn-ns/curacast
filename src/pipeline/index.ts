import fs from 'fs/promises';
import path from 'path';
import type { Config, UserProfile } from '../config/index.js';
import type { Article, Collector } from '../collectors/index.js';
import { RSSCollector, HatenaCollector, HackerNewsCollector } from '../collectors/index.js';
import { LLMSelector } from '../selectors/llm-selector.js';
import { LLMScriptGenerator } from '../generators/script-generator.js';
import type { Script } from '../generators/index.js';
import { createTTSProviderFromConfig } from '../tts/index.js';
import { createRSSFeedPublisher, type RSSFeedPublisher } from '../publishers/rss-feed.js';
import type { Episode } from '../publishers/index.js';
import { JsonStorage } from '../storage/json-storage.js';
import { splitText } from '../utils/text.js';
import { getAudioDuration, concatAudioBuffers } from '../utils/audio.js';
import { getLogger } from '../utils/logger.js';

export interface PipelineResult {
  success: boolean;
  episodeId?: string;
  episodeTitle?: string;
  scriptPath?: string;
  articleCount: number;
  error?: string;
}

export interface PipelineRunOptions {
  scriptOnly?: boolean;
}

export class Pipeline {
  private config: Config;
  private profile: UserProfile;
  private storage: JsonStorage;
  private feedPublisher: RSSFeedPublisher;
  private logger = getLogger();

  constructor(config: Config, profile: UserProfile) {
    this.config = config;
    this.profile = profile;
    this.storage = new JsonStorage(config.output.dataDir);
    this.feedPublisher = createRSSFeedPublisher({
      feedUrl: config.server.feedUrl,
      outputDir: config.output.audioDir,
    });
  }

  async initialize(): Promise<void> {
    await this.storage.load();

    // 出力ディレクトリを作成
    await fs.mkdir(this.config.output.scriptsDir, { recursive: true });
    await fs.mkdir(this.config.output.audioDir, { recursive: true });
    await fs.mkdir(this.config.output.dataDir, { recursive: true });

    this.logger.info('パイプラインを初期化しました');
  }

  async run(options: PipelineRunOptions = {}): Promise<PipelineResult> {
    const { scriptOnly = false } = options;

    try {
      this.logger.info({ scriptOnly }, 'パイプライン実行を開始');

      // 1. 記事収集
      const articles = await this.collectArticles();
      this.logger.info({ count: articles.length }, '記事を収集しました');

      if (articles.length === 0) {
        this.logger.info('収集された記事がありません');
        return { success: true, articleCount: 0 };
      }

      // 2. 重複チェック（処理済み記事を除外）
      const newArticles = articles.filter((a) => !this.storage.isProcessed(a.id));
      this.logger.info({ newCount: newArticles.length, totalCount: articles.length }, '新規記事をフィルタリング');

      if (newArticles.length === 0) {
        this.logger.info('新規記事がありません');
        return { success: true, articleCount: 0 };
      }

      // 3. AI記事選定
      const selector = new LLMSelector({
        provider: this.config.llm.provider,
        model: this.config.llm.model,
        apiKey: this.config.llm.apiKey ?? '',
      });
      const selectionResult = await selector.select(newArticles, this.profile);
      this.logger.info({ selectedCount: selectionResult.selected.length }, '記事を選定しました');

      if (selectionResult.selected.length === 0) {
        this.logger.info('選定された記事がありません');
        return { success: true, articleCount: 0 };
      }

      // 4. 台本生成
      const generator = new LLMScriptGenerator({
        provider: this.config.llm.provider,
        model: this.config.llm.model,
        apiKey: this.config.llm.apiKey ?? '',
      });
      const script = await generator.generate(selectionResult.selected, this.profile);
      this.logger.info({ scriptId: script.id, title: script.title }, '台本を生成しました');

      // 台本をファイルに保存
      const scriptPath = await this.saveScript(script);

      // scriptOnlyモードの場合はここで終了
      if (scriptOnly) {
        this.logger.info({ scriptPath }, '台本のみモード: 音声生成をスキップ');
        return {
          success: true,
          episodeId: script.id,
          episodeTitle: script.title,
          scriptPath,
          articleCount: selectionResult.selected.length,
        };
      }

      // 5. 音声生成
      const audioPath = await this.generateAudio(script);
      this.logger.info({ path: audioPath }, '音声を生成しました');

      // 6. エピソード公開
      const duration = await getAudioDuration(audioPath);
      const episode: Episode = {
        id: script.id,
        title: script.title,
        description: this.generateDescription(selectionResult.selected, selectionResult.reasons),
        audioPath,
        duration,
        publishedAt: new Date(),
        articles: selectionResult.selected.map((a) => ({
          title: a.title,
          url: a.url,
          source: a.sourceName ?? a.source,
        })),
      };

      await this.feedPublisher.publish(episode);
      this.logger.info({ episodeId: episode.id }, 'エピソードを公開しました');

      // 7. 処理済み記事をマーク
      for (const article of selectionResult.selected) {
        await this.storage.markAsProcessed(article, episode.id);
      }

      return {
        success: true,
        episodeId: episode.id,
        episodeTitle: episode.title,
        scriptPath,
        articleCount: selectionResult.selected.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error({ error: message }, 'パイプライン実行エラー');
      return {
        success: false,
        articleCount: 0,
        error: message,
      };
    }
  }

  private async collectArticles(): Promise<Article[]> {
    const collectors: Collector[] = [];

    // RSSコレクター
    if (this.config.collectors.rss.enabled && this.config.collectors.rss.feeds.length > 0) {
      collectors.push(
        new RSSCollector({
          feeds: this.config.collectors.rss.feeds,
        })
      );
    }

    // はてなブックマークコレクター
    if (this.config.collectors.hatena.enabled) {
      collectors.push(
        new HatenaCollector({
          categories: this.config.collectors.hatena.categories,
          minBookmarks: this.config.collectors.hatena.minBookmarks,
          maxArticles: this.config.collectors.hatena.maxArticles,
        })
      );
    }

    // Hacker Newsコレクター
    if (this.config.collectors.hackernews.enabled) {
      collectors.push(
        new HackerNewsCollector({
          minPoints: this.config.collectors.hackernews.minPoints,
          maxArticles: this.config.collectors.hackernews.maxArticles,
        })
      );
    }

    // 全コレクターを並列実行
    const results = await Promise.all(collectors.map((c) => c.collect()));
    return results.flat();
  }

  private async saveScript(script: Script): Promise<string> {
    const fileName = `${script.id}.txt`;
    const filePath = path.join(this.config.output.scriptsDir, fileName);
    await fs.writeFile(filePath, script.content, 'utf-8');
    this.logger.debug({ path: filePath }, '台本を保存しました');
    return filePath;
  }

  private async generateAudio(script: Script): Promise<string> {
    const ttsProvider = createTTSProviderFromConfig(this.config);
    const chunks = splitText(script.content, { maxChunkSize: this.config.tts.chunkSize });

    this.logger.info({ chunkCount: chunks.length }, 'テキストを分割しました');

    // チャンクを並列処理
    const audioBuffers: Buffer[] = new Array(chunks.length);
    const concurrency = this.config.tts.concurrency;

    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (chunk, index) => {
          const absoluteIndex = i + index;
          this.logger.debug({ chunk: absoluteIndex + 1, total: chunks.length }, 'チャンク処理中');
          const buffer = await ttsProvider.generateAudio(chunk);
          return { index: absoluteIndex, buffer };
        })
      );

      for (const { index, buffer } of batchResults) {
        audioBuffers[index] = buffer;
      }

      this.logger.info(
        { processed: Math.min(i + concurrency, chunks.length), total: chunks.length },
        'バッチ処理完了'
      );
    }

    // 音声を結合
    const combinedBuffer = concatAudioBuffers(audioBuffers.filter((b): b is Buffer => b !== undefined));

    // ファイルに保存
    const fileName = `${script.id}.mp3`;
    const outputPath = path.join(this.config.output.audioDir, fileName);
    await fs.writeFile(outputPath, combinedBuffer);

    return outputPath;
  }

  private generateDescription(articles: Article[], reasons: Map<string, string>): string {
    const lines = ['今日紹介する記事:'];

    for (const article of articles) {
      const reason = reasons.get(article.id);
      lines.push(`- ${article.title} (${article.sourceName ?? article.source})`);
      if (reason) {
        lines.push(`  ${reason}`);
      }
    }

    return lines.join('\n');
  }

  getFeedPublisher(): RSSFeedPublisher {
    return this.feedPublisher;
  }
}
