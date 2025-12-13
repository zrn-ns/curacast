// 記事情報
export interface Article {
  id: string;              // 一意のID（URL hash等）
  url: string;             // 記事URL
  title: string;           // タイトル
  description?: string;    // 説明・要約
  content?: string;        // 本文（取得可能な場合）
  source: string;          // ソース名（'rss', 'hatena', 'hackernews'）
  sourceName?: string;     // ソースの表示名（'Zenn', 'Publickey'等）
  publishedAt?: Date;      // 公開日時
  metadata: {              // ソース固有のメタデータ
    bookmarks?: number;    // はてブ数
    points?: number;       // HN points
    comments?: number;     // コメント数
    category?: string;     // カテゴリ
  };
}

// コレクターインターフェース
export interface Collector {
  name: string;
  collect(): Promise<Article[]>;
}

// コレクターの結果
export interface CollectorResult {
  source: string;
  articles: Article[];
  error?: string;
}

export { RSSCollector, type RSSCollectorConfig } from './rss.js';
export { HatenaCollector, type HatenaCollectorConfig } from './hatena.js';
export { HackerNewsCollector, type HackerNewsCollectorConfig } from './hackernews.js';
