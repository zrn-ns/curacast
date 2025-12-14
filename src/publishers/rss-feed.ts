import RSS from 'rss';
import fs from 'fs/promises';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import type { Publisher, Episode } from './index.js';
import { formatDuration } from '../utils/audio.js';
import { getLogger } from '../utils/logger.js';

export interface RSSFeedConfig {
  title: string;
  description: string;
  feedUrl: string;
  siteUrl: string;
  language: string;
  imageUrl?: string;
  author?: string;
  category?: string;
  outputPath: string;
}

export class RSSFeedPublisher implements Publisher {
  private feed: RSS;
  private config: RSSFeedConfig;
  private logger = getLogger();

  constructor(config: RSSFeedConfig) {
    this.config = config;
    this.feed = this.createFeed();
  }

  /**
   * 既存のfeed.xmlを読み込んでエピソードを復元する
   */
  async loadExistingFeed(): Promise<void> {
    try {
      const feedPath = this.config.outputPath;
      const feedContent = await fs.readFile(feedPath, 'utf-8');

      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
      });
      const parsed = parser.parse(feedContent);

      const channel = parsed?.rss?.channel;
      if (!channel) {
        this.logger.debug('既存フィードにchannelが見つかりません');
        return;
      }

      // itemが配列でない場合（1件のみ）は配列に変換
      const items = channel.item
        ? Array.isArray(channel.item)
          ? channel.item
          : [channel.item]
        : [];

      this.logger.info({ count: items.length }, '既存フィードからエピソードを復元中');

      for (const item of items) {
        this.feed.item({
          title: item.title ?? '',
          description: item.description ?? '',
          url: item.link ?? '',
          guid: item.guid?.['#text'] ?? item.guid ?? '',
          date: item.pubDate ? new Date(item.pubDate) : new Date(),
          enclosure: item.enclosure
            ? {
                url: item.enclosure['@_url'] ?? '',
                type: item.enclosure['@_type'] ?? 'audio/mpeg',
              }
            : undefined,
          custom_elements: [
            item['itunes:image']
              ? {
                  'itunes:image': {
                    _attr: { href: item['itunes:image']['@_href'] ?? '' },
                  },
                }
              : null,
            item['itunes:duration']
              ? { 'itunes:duration': item['itunes:duration'] }
              : null,
            { 'itunes:explicit': 'no' },
            item['content:encoded']
              ? { 'content:encoded': { _cdata: item['content:encoded'] } }
              : null,
          ].filter(Boolean),
        });
      }

      this.logger.info({ count: items.length }, '既存エピソードの復元完了');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug('既存のfeed.xmlが見つかりません。新規作成します');
      } else {
        this.logger.warn({ error }, '既存フィードの読み込みに失敗しました');
      }
    }
  }

  private createFeed(): RSS {
    const baseUrl = this.config.feedUrl.replace('/feed.xml', '');

    return new RSS({
      title: this.config.title,
      description: this.config.description,
      feed_url: this.config.feedUrl,
      site_url: this.config.siteUrl,
      language: this.config.language,
      pubDate: new Date(),
      custom_namespaces: {
        itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
        content: 'http://purl.org/rss/1.0/modules/content/',
      },
      custom_elements: [
        {
          'itunes:image': {
            _attr: {
              href: this.config.imageUrl ?? `${baseUrl}/images/podcast-cover.png`,
            },
          },
        },
        { 'itunes:author': this.config.author ?? 'CuraCast' },
        {
          'itunes:category': {
            _attr: {
              text: this.config.category ?? 'Technology',
            },
          },
        },
        { 'itunes:explicit': 'no' },
        { 'itunes:type': 'episodic' },
      ],
    });
  }

  async publish(episode: Episode): Promise<void> {
    const baseUrl = this.config.feedUrl.replace('/feed.xml', '');
    const audioFileName = path.basename(episode.audioPath);
    const durationStr = formatDuration(episode.duration);

    // content:encoded用のHTMLコンテンツを生成
    const contentHtml = this.generateContentHtml(episode);

    this.feed.item({
      title: episode.title,
      description: episode.description,
      url: `${baseUrl}/audio/${audioFileName}`,
      guid: episode.id,
      date: episode.publishedAt,
      enclosure: {
        url: `${baseUrl}/audio/${audioFileName}`,
        type: 'audio/mpeg',
      },
      custom_elements: [
        {
          'itunes:image': {
            _attr: {
              href: this.config.imageUrl ?? `${baseUrl}/images/podcast-cover.png`,
            },
          },
        },
        { 'itunes:duration': durationStr },
        { 'itunes:explicit': 'no' },
        { 'content:encoded': { _cdata: contentHtml } },
      ],
    });

    // RSSフィードをファイルに保存
    await this.saveFeed();

    this.logger.info({ episodeId: episode.id, title: episode.title }, 'エピソードをRSSフィードに追加');
  }

  getFeed(): string {
    return this.feed.xml({ indent: true });
  }

  private async saveFeed(): Promise<void> {
    const feedXml = this.getFeed();
    const outputDir = path.dirname(this.config.outputPath);

    // ディレクトリが存在しない場合は作成
    await fs.mkdir(outputDir, { recursive: true });

    await fs.writeFile(this.config.outputPath, feedXml, 'utf-8');
    this.logger.debug({ path: this.config.outputPath }, 'RSSフィードを保存');
  }

  private generateContentHtml(episode: Episode): string {
    const parts: string[] = [];

    // 紹介記事セクション
    if (episode.articles && episode.articles.length > 0) {
      parts.push('<h2>紹介した記事</h2>');
      parts.push('<ul>');
      for (const article of episode.articles) {
        parts.push(`<li><a href="${this.escapeHtml(article.url)}">${this.escapeHtml(article.title)}</a> (${this.escapeHtml(article.source)})</li>`);
      }
      parts.push('</ul>');
    }

    // 台本セクション
    if (episode.script) {
      parts.push('<h2>台本</h2>');
      parts.push(`<pre>${this.escapeHtml(episode.script)}</pre>`);
    }

    return parts.join('\n');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// 設定からRSSFeedPublisherを作成するヘルパー
export function createRSSFeedPublisher(options: {
  feedUrl: string;
  outputDir: string;
  title?: string;
  description?: string;
}): RSSFeedPublisher {
  return new RSSFeedPublisher({
    title: options.title ?? 'CuraCast Podcast',
    description: options.description ?? 'AIキュレーションによる自動生成ポッドキャスト',
    feedUrl: options.feedUrl,
    siteUrl: options.feedUrl.replace('/feed.xml', ''),
    language: 'ja',
    outputPath: path.join(options.outputDir, 'feed.xml'),
  });
}
