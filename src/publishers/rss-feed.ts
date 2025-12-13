import RSS from 'rss';
import fs from 'fs/promises';
import path from 'path';
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
