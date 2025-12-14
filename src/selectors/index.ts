import type { Article } from '../collectors/index.js';
import type { UserProfile } from '../config/index.js';

// 優先度付き記事
export interface ArticleWithPriority {
  article: Article;
  priority: number; // 1が最高優先度
  reason: string;
}

// 選定結果
export interface SelectionResult {
  selected: Article[];
  reasons: Map<string, string>; // 記事ID → 選定理由
  priorities: Map<string, number>; // 記事ID → 優先度（1が最高）
}

// セレクターインターフェース
export interface Selector {
  select(articles: Article[], profile: UserProfile): Promise<SelectionResult>;
}

export { LLMSelector, type LLMSelectorConfig } from './llm-selector.js';
