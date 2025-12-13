import Parser from 'rss-parser';
import type { Collector, Article } from './index.js';
import { generateArticleId } from '../utils/text.js';
import { getLogger } from '../utils/logger.js';

export interface HatenaCollectorConfig {
  categories: string[];
  minBookmarks: number;
  maxArticles: number;
}

// はてなブックマークのカテゴリマッピング
const CATEGORY_MAP: Record<string, string> = {
  テクノロジー: 'it',
  エンタメ: 'entertainment',
  アニメとゲーム: 'game',
  おもしろ: 'fun',
  暮らし: 'life',
  学び: 'knowledge',
  政治と経済: 'social',
  世の中: 'general',
};

export class HatenaCollector implements Collector {
  name = 'hatena';

  private config: HatenaCollectorConfig;
  private parser: Parser;
  private logger = getLogger();

  constructor(config: HatenaCollectorConfig) {
    this.config = config;
    this.parser = new Parser({
      timeout: 10000,
      headers: {
        'User-Agent': 'CuraCast/1.0',
      },
    });
  }

  async collect(): Promise<Article[]> {
    const allArticles: Article[] = [];

    for (const category of this.config.categories) {
      try {
        const categoryId = CATEGORY_MAP[category] ?? category.toLowerCase();
        const feedUrl = `https://b.hatena.ne.jp/hotentry/${categoryId}.rss`;

        this.logger.debug({ category, url: feedUrl }, 'はてなブックマークを取得中');

        const parsedFeed = await this.parser.parseURL(feedUrl);
        const articles = (parsedFeed.items ?? [])
          .map((item): Article => {
            // はてブ数を抽出（タイトルから）
            const bookmarkMatch = item.title?.match(/\[(\d+)\s*users?\]/i);
            const bookmarks = bookmarkMatch ? parseInt(bookmarkMatch[1] ?? '0', 10) : 0;

            // タイトルからはてブ数表記を除去
            const cleanTitle = item.title?.replace(/\s*\[\d+\s*users?\]/i, '') ?? '';

            return {
              id: generateArticleId(item.link ?? item.guid ?? item.title ?? ''),
              url: item.link ?? '',
              title: cleanTitle,
              description: item.contentSnippet ?? item.content ?? '',
              content: item.content,
              source: 'hatena',
              sourceName: 'はてなブックマーク',
              publishedAt: item.pubDate ? new Date(item.pubDate) : undefined,
              metadata: {
                bookmarks,
                category,
              },
            };
          })
          .filter((article) => article.metadata.bookmarks !== undefined && article.metadata.bookmarks >= this.config.minBookmarks)
          .slice(0, this.config.maxArticles);

        allArticles.push(...articles);
        this.logger.info({ category, count: articles.length }, 'はてなブックマークから記事を取得');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error({ category, error: message }, 'はてなブックマーク取得エラー');
      }
    }

    return allArticles;
  }
}
