import type { Article } from '../collectors/index.js';
import type { UserProfile } from '../config/index.js';

// 生成された台本
export interface Script {
  id: string;
  title: string;
  content: string;           // テキスト形式の台本
  articles: Article[];       // 参照記事
  generatedAt: Date;
  estimatedDuration?: number; // 推定再生時間（分）
  // 特別回用フィールド
  isSpecialEpisode?: boolean;  // 特別回かどうか
  requestedTopic?: string;     // リクエストされたトピック
  sources?: string[];          // 参照元URL（Grounding使用時）
}

// 台本生成オプション
export interface GeneratorOptions {
  style: 'casual' | 'formal' | 'news';
  maxLength: number;         // 最大文字数
  includeIntro: boolean;     // オープニング挨拶
  includeOutro: boolean;     // エンディング挨拶
  language: string;
}

// ジェネレーターインターフェース
export interface ScriptGenerator {
  generate(articles: Article[], profile: UserProfile): Promise<Script>;
}

export { LLMScriptGenerator, type LLMScriptGeneratorConfig } from './script-generator.js';
