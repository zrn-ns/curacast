// エピソード情報
export interface Episode {
  id: string;
  title: string;
  description: string;
  audioPath: string;
  duration: number; // 秒
  publishedAt: Date;
  articles?: {
    title: string;
    url: string;
    source: string;
  }[];
}

// パブリッシャーインターフェース
export interface Publisher {
  publish(episode: Episode): Promise<void>;
  getFeed(): string;
}

export { RSSFeedPublisher } from './rss-feed.js';
export { createServer } from './server.js';
