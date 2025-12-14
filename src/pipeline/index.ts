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
import { getAudioDuration, concatMp3Buffers, embedArtwork } from '../utils/audio.js';
import { getLogger } from '../utils/logger.js';
import { fetchArticleContent, truncateContent } from '../utils/article-fetcher.js';

// 記事と取得した本文
interface ArticleWithContent extends Article {
  fetchedContent?: string;
}

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

    // 既存のフィードを読み込む
    await this.feedPublisher.loadExistingFeed();

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

      // 2. 重複チェック（処理済み記事を除外）+ 失敗URL除外
      const newArticles = articles.filter((a) => {
        if (this.storage.isProcessed(a.id)) return false;
        if (this.storage.isUrlFailed(a.url)) {
          this.logger.debug({ url: a.url }, '以前失敗したURLを除外');
          return false;
        }
        return true;
      });
      this.logger.info({ newCount: newArticles.length, totalCount: articles.length }, '新規記事をフィルタリング');

      if (newArticles.length === 0) {
        this.logger.info('新規記事がありません');
        return { success: true, articleCount: 0 };
      }

      // 3. AI記事選定（多めに選定、優先度付き）
      const selector = new LLMSelector({
        provider: this.config.llm.provider,
        model: this.config.llm.model,
        apiKey: this.config.llm.apiKey ?? '',
        selectionMultiplier: 1.5, // 目標の1.5倍を選定
      });
      const selectionResult = await selector.select(newArticles, this.profile);
      this.logger.info({ selectedCount: selectionResult.selected.length }, '記事を選定しました（優先度付き）');

      if (selectionResult.selected.length === 0) {
        this.logger.info('選定された記事がありません');
        return { success: true, articleCount: 0 };
      }

      // 4. 記事本文を取得し、成功した記事から目標数を採用
      const articlesWithContent = await this.fetchArticleContentsWithFallback(
        selectionResult.selected,
        selectionResult.priorities,
        this.profile.maxArticlesPerRun
      );
      this.logger.info(
        { finalCount: articlesWithContent.length, targetCount: this.profile.maxArticlesPerRun },
        '記事本文取得完了、最終選定'
      );

      if (articlesWithContent.length === 0) {
        this.logger.warn('本文を取得できた記事がありません');
        return { success: true, articleCount: 0 };
      }

      // 5. 台本生成
      const generator = new LLMScriptGenerator({
        provider: this.config.llm.provider,
        model: this.config.llm.model,
        apiKey: this.config.llm.apiKey ?? '',
      });
      const script = await generator.generateWithContent(articlesWithContent, this.profile);
      this.logger.info({ scriptId: script.id, title: script.title }, '台本を生成しました');

      // 台本をファイルに保存
      const scriptPath = await this.saveScript(script);

      // 使用した記事のリストを作成（reasonsを引き継ぐ）
      const finalArticles = articlesWithContent.map((a) => a as Article);
      const finalReasons = new Map<string, string>();
      for (const article of finalArticles) {
        const reason = selectionResult.reasons.get(article.id);
        if (reason) {
          finalReasons.set(article.id, reason);
        }
      }

      // scriptOnlyモードの場合はここで終了
      if (scriptOnly) {
        this.logger.info({ scriptPath }, '台本のみモード: 音声生成をスキップ');
        return {
          success: true,
          episodeId: script.id,
          episodeTitle: script.title,
          scriptPath,
          articleCount: finalArticles.length,
        };
      }

      // 6. 音声生成
      const audioPath = await this.generateAudio(script);
      this.logger.info({ path: audioPath }, '音声を生成しました');

      // 7. エピソード公開
      const duration = await getAudioDuration(audioPath);
      const episode: Episode = {
        id: script.id,
        title: script.title,
        description: this.generateDescription(finalArticles, finalReasons),
        audioPath,
        duration,
        publishedAt: new Date(),
        script: script.content,
        articles: finalArticles.map((a) => ({
          title: a.title,
          url: a.url,
          source: a.sourceName ?? a.source,
        })),
      };

      await this.feedPublisher.publish(episode);
      this.logger.info({ episodeId: episode.id }, 'エピソードを公開しました');

      // 8. 処理済み記事をマーク
      for (const article of finalArticles) {
        await this.storage.markAsProcessed(article, episode.id);
      }

      return {
        success: true,
        episodeId: episode.id,
        episodeTitle: episode.title,
        scriptPath,
        articleCount: finalArticles.length,
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

  /**
   * 記事本文を取得し、成功した記事から目標数を優先度順に採用
   * 失敗した記事は記録して次回以降の選定から除外
   */
  private async fetchArticleContentsWithFallback(
    articles: Article[],
    priorities: Map<string, number>,
    targetCount: number
  ): Promise<ArticleWithContent[]> {
    this.logger.info({ count: articles.length }, '記事本文を取得中...');

    const results: ArticleWithContent[] = [];
    const failedUrls: { url: string; error: string }[] = [];

    // 優先度順にソート済みの記事を並列で取得（3件ずつ）
    for (let i = 0; i < articles.length; i += 3) {
      const batch = articles.slice(i, i + 3);
      const batchResults = await Promise.all(
        batch.map(async (article) => {
          try {
            const fetched = await fetchArticleContent(article.url);
            if (fetched?.textContent) {
              return {
                article,
                content: truncateContent(fetched.textContent, 5000),
                success: true,
              };
            } else {
              return {
                article,
                content: null,
                success: false,
                error: '本文を抽出できませんでした',
              };
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            return {
              article,
              content: null,
              success: false,
              error: message,
            };
          }
        })
      );

      for (const result of batchResults) {
        if (result.success && result.content) {
          results.push({
            ...result.article,
            fetchedContent: result.content,
          });
        } else {
          failedUrls.push({
            url: result.article.url,
            error: result.error ?? '不明なエラー',
          });
          this.logger.warn(
            { url: result.article.url, error: result.error },
            '記事本文の取得に失敗'
          );
        }
      }

      // 既に目標数に達していれば終了
      if (results.length >= targetCount) {
        this.logger.debug(
          { fetched: results.length, target: targetCount },
          '目標数に達したため残りの記事取得をスキップ'
        );
        break;
      }
    }

    // 失敗URLを記録（次回以降の選定から除外するため）
    for (const { url, error } of failedUrls) {
      await this.storage.markUrlAsFailed(url, error);
    }

    this.logger.info(
      {
        total: articles.length,
        success: results.length,
        failed: failedUrls.length,
      },
      '記事本文の取得完了'
    );

    // 目標数に制限して返す
    return results.slice(0, targetCount);
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

    // 音声を結合（ffmpegを使用してメタデータも正しく設定）
    const tempDir = path.join(this.config.output.audioDir, '.temp');
    const combinedBuffer = await concatMp3Buffers(
      audioBuffers.filter((b): b is Buffer => b !== undefined),
      tempDir
    );

    // 一時ファイルに保存
    const fileName = `${script.id}.mp3`;
    const tempMp3Path = path.join(tempDir, `temp_${fileName}`);
    const outputPath = path.join(this.config.output.audioDir, fileName);

    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(tempMp3Path, combinedBuffer);

    // アートワークを埋め込み
    const artworkPath = path.resolve('./public/images/podcast-cover.png');
    try {
      await fs.access(artworkPath);
      await embedArtwork(tempMp3Path, artworkPath, outputPath, {
        title: script.title,
        artist: this.profile.narrator?.name ?? 'CuraCast',
        album: 'CuraCast Podcast',
      });
      this.logger.debug('アートワークを埋め込みました');
    } catch {
      // アートワークがない場合は結合したファイルをそのまま使用
      this.logger.debug('アートワークが見つからないため、埋め込みをスキップ');
      await fs.rename(tempMp3Path, outputPath);
    }

    // 一時ファイルを削除
    try {
      await fs.unlink(tempMp3Path);
    } catch {
      // 削除エラーは無視（renameで移動済みの場合など）
    }

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

  getStorage(): JsonStorage {
    return this.storage;
  }

  // 全エピソードを削除（音声ファイル、台本、フィードをクリア）
  async clearAllEpisodes(): Promise<{ audioFiles: number; scriptFiles: number }> {
    let audioFiles = 0;
    let scriptFiles = 0;

    // 音声ファイルを削除
    try {
      const audioDir = this.config.output.audioDir;
      const files = await fs.readdir(audioDir);
      for (const file of files) {
        if (file.endsWith('.mp3')) {
          await fs.unlink(path.join(audioDir, file));
          audioFiles++;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    // 台本ファイルを削除
    try {
      const scriptsDir = this.config.output.scriptsDir;
      const files = await fs.readdir(scriptsDir);
      for (const file of files) {
        if (file.endsWith('.txt')) {
          await fs.unlink(path.join(scriptsDir, file));
          scriptFiles++;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    // RSSフィードをクリア
    await this.feedPublisher.clearFeed();

    this.logger.info({ audioFiles, scriptFiles }, '全エピソードを削除しました');
    return { audioFiles, scriptFiles };
  }

  // ピックアップ済み記事をクリア
  async clearProcessedArticles(): Promise<number> {
    return await this.storage.clearProcessedArticles();
  }

  // 失敗URLをクリア
  async clearFailedUrls(): Promise<number> {
    return await this.storage.clearFailedUrls();
  }
}
