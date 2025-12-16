import fs from 'fs';
import path from 'path';
import { getLogger } from './logger.js';

const logger = getLogger();

// オープニングトピック履歴の型定義
export interface OpeningTopicEntry {
  date: string; // YYYY-MM-DD形式
  topic: string; // オープニングで使用したトピック
}

export interface OpeningTopicHistory {
  topics: OpeningTopicEntry[];
}

// デフォルトの履歴ファイルパス
const DEFAULT_HISTORY_PATH = path.resolve(process.cwd(), 'data/opening-topic-history.json');

// 保持する最大履歴数
const MAX_HISTORY_COUNT = 14;

/**
 * オープニングトピックの履歴を読み込む
 */
export function loadOpeningTopicHistory(historyPath?: string): OpeningTopicHistory {
  const filePath = historyPath ?? DEFAULT_HISTORY_PATH;

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const history = JSON.parse(content) as OpeningTopicHistory;
      return history;
    }
  } catch (error) {
    logger.warn({ error }, 'オープニングトピック履歴の読み込みに失敗。新規作成します');
  }

  return { topics: [] };
}

/**
 * オープニングトピックの履歴を保存する
 */
export function saveOpeningTopicHistory(
  history: OpeningTopicHistory,
  historyPath?: string
): void {
  const filePath = historyPath ?? DEFAULT_HISTORY_PATH;

  // 最大件数を超えた場合、古いものを削除
  const trimmedHistory: OpeningTopicHistory = {
    topics: history.topics.slice(-MAX_HISTORY_COUNT),
  };

  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(trimmedHistory, null, 2), 'utf-8');
  logger.debug({ path: filePath }, 'オープニングトピック履歴を保存しました');
}

/**
 * 新しいトピックを履歴に追加する
 */
export function addOpeningTopic(
  topic: string,
  date?: Date,
  historyPath?: string
): void {
  const history = loadOpeningTopicHistory(historyPath);
  const targetDate = date ?? new Date();
  const dateStr = formatDate(targetDate);

  // 同じ日付のエントリがあれば更新、なければ追加
  const existingIndex = history.topics.findIndex((t) => t.date === dateStr);
  if (existingIndex >= 0) {
    history.topics[existingIndex] = { date: dateStr, topic };
  } else {
    history.topics.push({ date: dateStr, topic });
  }

  saveOpeningTopicHistory(history, historyPath);
}

/**
 * 直近のトピック一覧を取得する（プロンプト用）
 */
export function getRecentTopics(count?: number, historyPath?: string): string[] {
  const history = loadOpeningTopicHistory(historyPath);
  const limit = count ?? 7; // デフォルトで直近1週間分
  return history.topics.slice(-limit).map((t) => t.topic);
}

/**
 * プロンプト用に「避けるべきトピック」のテキストを生成する
 */
export function getAvoidTopicsPrompt(historyPath?: string): string {
  const recentTopics = getRecentTopics(7, historyPath);

  if (recentTopics.length === 0) {
    return '';
  }

  return `
【重要】オープニングトークのバリエーション
直近の放送で以下のトピックを使用しました。同じトピックの繰り返しを避けてください:
${recentTopics.map((t) => `- ${t}`).join('\n')}

上記とは異なる、新鮮なトピックを選んでください。
例えば以下のようなバリエーションを検討してください:
- 今日は何の日（記念日、歴史的な出来事、偉人の誕生日など）
- 季節の行事・イベント（ただし直近で触れたもの以外）
- 最近の時事ニュース・社会の動向
- 季節の自然・天候（紅葉、初雪、花粉など）
- 曜日にちなんだ話題（週末の過ごし方、月曜日の気分など）
- テクノロジー・科学の記念日や発見
- 食べ物・旬の味覚
`;
}

// 日付をYYYY-MM-DD形式にフォーマット
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}
