import { z } from 'zod';

// RSSフィード設定
const rssFeedSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  category: z.string().optional(),
});

// コレクター設定
const collectorsSchema = z.object({
  rss: z.object({
    enabled: z.boolean().default(true),
    feeds: z.array(rssFeedSchema).default([]),
  }).default({ enabled: true, feeds: [] }),
  hatena: z.object({
    enabled: z.boolean().default(true),
    categories: z.array(z.string()).default(['テクノロジー']),
    minBookmarks: z.number().default(50),
    maxArticles: z.number().default(20),
  }).default({ enabled: true, categories: ['テクノロジー'], minBookmarks: 50, maxArticles: 20 }),
  hackernews: z.object({
    enabled: z.boolean().default(true),
    minPoints: z.number().default(100),
    maxArticles: z.number().default(15),
  }).default({ enabled: true, minPoints: 100, maxArticles: 15 }),
});

// LLM設定
const llmSchema = z.object({
  provider: z.enum(['gemini', 'openai']).default('gemini'),
  model: z.string().default('gemini-2.0-flash'),
  apiKey: z.string().optional(),
});

// TTS設定
const ttsSchema = z.object({
  provider: z.enum(['gemini', 'openai']).default('gemini'),
  model: z.string().default('gemini-2.5-flash-preview-tts'),
  voices: z.array(z.string()).default(['Laomedeia']),
  chunkSize: z.number().default(1500),
  concurrency: z.number().default(6),
  apiKey: z.string().optional(),
});

// サーバー設定
const serverSchema = z.object({
  port: z.number().default(3000),
  feedUrl: z.string().url().default('http://localhost:3000/feed.xml'),
});

// スケジュール設定
const scheduleSchema = z.object({
  cron: z.string().default('0 7 * * *'),
  timezone: z.string().default('Asia/Tokyo'),
});

// 出力設定
const outputSchema = z.object({
  scriptsDir: z.string().default('./output/scripts'),
  audioDir: z.string().default('./output/audio'),
  dataDir: z.string().default('./data'),
});

// ログ設定
const loggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

// メイン設定スキーマ
export const configSchema = z.object({
  mode: z.enum(['batch', 'watch', 'once']).default('batch'),
  schedule: scheduleSchema.default({}),
  collectors: collectorsSchema.default({}),
  llm: llmSchema.default({}),
  tts: ttsSchema.default({}),
  server: serverSchema.default({}),
  output: outputSchema.default({}),
  logging: loggingSchema.default({}),
});

export type Config = z.infer<typeof configSchema>;

// 台本スタイル設定
const scriptStyleSchema = z.object({
  tone: z.enum(['casual', 'formal', 'news']).default('casual'),
  includeIntro: z.boolean().default(true),
  includeOutro: z.boolean().default(true),
  maxDuration: z.number().default(10),
  language: z.string().default('ja'),
});

// カスタムプロンプト設定
const customPromptsSchema = z.object({
  selection: z.string().optional(),
  scriptGeneration: z.string().optional(),
});

// ユーザープロファイルスキーマ
export const profileSchema = z.object({
  interests: z.array(z.string()).default([]),
  excludeTopics: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  maxArticlesPerRun: z.number().default(5),
  preferredSources: z.array(z.string()).default([]),
  scriptStyle: scriptStyleSchema.default({}),
  customPrompts: customPromptsSchema.default({}),
});

export type UserProfile = z.infer<typeof profileSchema>;
