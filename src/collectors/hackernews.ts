import type { Collector, Article } from './index.js';
import { generateArticleId } from '../utils/text.js';
import { getLogger } from '../utils/logger.js';

export interface HackerNewsCollectorConfig {
  minPoints: number;
  maxArticles: number;
}

interface HNStory {
  id: number;
  title: string;
  url?: string;
  score: number;
  by: string;
  time: number;
  descendants?: number; // コメント数
  type: string;
}

const HN_API_BASE = 'https://hacker-news.firebaseio.com/v0';

export class HackerNewsCollector implements Collector {
  name = 'hackernews';

  private config: HackerNewsCollectorConfig;
  private logger = getLogger();

  constructor(config: HackerNewsCollectorConfig) {
    this.config = config;
  }

  async collect(): Promise<Article[]> {
    try {
      this.logger.debug('Hacker Newsを取得中');

      // トップストーリーのIDリストを取得
      const topStoriesRes = await fetch(`${HN_API_BASE}/topstories.json`);
      const topStoryIds = (await topStoriesRes.json()) as number[];

      // 上位のストーリーを取得（maxArticles * 2 を取得して、フィルタリング後に十分な数を確保）
      const storiesToFetch = topStoryIds.slice(0, this.config.maxArticles * 2);

      const stories = await Promise.all(
        storiesToFetch.map(async (id): Promise<HNStory | null> => {
          try {
            const res = await fetch(`${HN_API_BASE}/item/${id}.json`);
            return (await res.json()) as HNStory;
          } catch {
            return null;
          }
        })
      );

      const articles = stories
        .filter((story): story is HNStory => {
          if (!story) return false;
          if (story.type !== 'story') return false;
          if (!story.url) return false; // 外部リンクがないものは除外
          if (story.score < this.config.minPoints) return false;
          return true;
        })
        .slice(0, this.config.maxArticles)
        .map((story): Article => ({
          id: generateArticleId(story.url ?? `hn-${story.id}`),
          url: story.url ?? `https://news.ycombinator.com/item?id=${story.id}`,
          title: story.title,
          description: `Posted by ${story.by} | ${story.score} points | ${story.descendants ?? 0} comments`,
          source: 'hackernews',
          sourceName: 'Hacker News',
          publishedAt: new Date(story.time * 1000),
          metadata: {
            points: story.score,
            comments: story.descendants ?? 0,
          },
        }));

      this.logger.info({ count: articles.length }, 'Hacker Newsから記事を取得');
      return articles;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error({ error: message }, 'Hacker News取得エラー');
      return [];
    }
  }
}
