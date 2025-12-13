import Parser from 'rss-parser';
import type { Collector, Article } from './index.js';
import { generateArticleId } from '../utils/text.js';
import { getLogger } from '../utils/logger.js';

export interface RSSFeed {
  name: string;
  url: string;
  category?: string;
}

export interface RSSCollectorConfig {
  feeds: RSSFeed[];
}

export class RSSCollector implements Collector {
  name = 'rss';

  private feeds: RSSFeed[];
  private parser: Parser;
  private logger = getLogger();

  constructor(config: RSSCollectorConfig) {
    this.feeds = config.feeds;
    this.parser = new Parser({
      timeout: 10000,
      headers: {
        'User-Agent': 'CuraCast/1.0',
      },
    });
  }

  async collect(): Promise<Article[]> {
    const allArticles: Article[] = [];

    for (const feed of this.feeds) {
      try {
        this.logger.debug({ feedName: feed.name, url: feed.url }, 'RSSフィードを取得中');

        const parsedFeed = await this.parser.parseURL(feed.url);
        const articles = (parsedFeed.items ?? []).map((item): Article => ({
          id: generateArticleId(item.link ?? item.guid ?? item.title ?? ''),
          url: item.link ?? '',
          title: item.title ?? '',
          description: item.contentSnippet ?? item.content ?? '',
          content: item.content,
          source: 'rss',
          sourceName: feed.name,
          publishedAt: item.pubDate ? new Date(item.pubDate) : undefined,
          metadata: {
            category: feed.category,
          },
        }));

        allArticles.push(...articles);
        this.logger.info({ feedName: feed.name, count: articles.length }, 'RSSフィードから記事を取得');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error({ feedName: feed.name, error: message }, 'RSSフィード取得エラー');
      }
    }

    return allArticles;
  }
}
