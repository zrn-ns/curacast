import type { Article } from '../collectors/index.js';
import type { UserProfile } from '../config/index.js';

// 選定結果
export interface SelectionResult {
  selected: Article[];
  reasons: Map<string, string>; // 記事ID → 選定理由
}

// セレクターインターフェース
export interface Selector {
  select(articles: Article[], profile: UserProfile): Promise<SelectionResult>;
}

export { LLMSelector, type LLMSelectorConfig } from './llm-selector.js';
