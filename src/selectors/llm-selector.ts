import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type { Selector, SelectionResult } from './index.js';
import type { Article } from '../collectors/index.js';
import type { UserProfile } from '../config/index.js';
import { getLogger } from '../utils/logger.js';

export interface LLMSelectorConfig {
  provider: 'gemini' | 'openai';
  model: string;
  apiKey: string;
  selectionMultiplier?: number; // 目標数に対する選定倍率（デフォルト: 1.5）
}

interface SelectionResponse {
  selectedArticles: {
    id: string;
    priority: number; // 優先度（1が最高）
    reason: string;
  }[];
}

export class LLMSelector implements Selector {
  private config: LLMSelectorConfig;
  private logger = getLogger();

  constructor(config: LLMSelectorConfig) {
    this.config = config;
  }

  async select(articles: Article[], profile: UserProfile): Promise<SelectionResult> {
    if (articles.length === 0) {
      return { selected: [], reasons: new Map(), priorities: new Map() };
    }

    // 選定倍率を適用した選定数を計算
    const multiplier = this.config.selectionMultiplier ?? 1.5;
    const targetCount = Math.ceil(profile.maxArticlesPerRun * multiplier);

    const prompt = this.buildPrompt(articles, profile, targetCount);
    this.logger.debug({ articleCount: articles.length, targetCount }, 'LLMによる記事選定を開始');

    try {
      const responseText = await this.callLLM(prompt);
      const result = this.parseResponse(responseText, articles);

      this.logger.info(
        { selectedCount: result.selected.length, totalCount: articles.length },
        'LLMによる記事選定が完了'
      );

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error({ error: message }, 'LLM記事選定エラー');
      throw error;
    }
  }

  private buildPrompt(articles: Article[], profile: UserProfile, targetCount: number): string {
    const articlesList = articles
      .map(
        (a, i) =>
          `${i + 1}. [ID: ${a.id}]
   タイトル: ${a.title}
   ソース: ${a.sourceName ?? a.source}
   説明: ${a.description?.slice(0, 200) ?? '(なし)'}
   ${a.metadata.bookmarks ? `ブックマーク数: ${a.metadata.bookmarks}` : ''}
   ${a.metadata.points ? `ポイント: ${a.metadata.points}` : ''}`
      )
      .join('\n\n');

    const customPrompt = profile.customPrompts?.selection ?? '';

    return `あなたは記事キュレーションのエキスパートです。
以下のユーザープロファイルに基づいて、記事リストから最も興味深い記事を選定してください。

## ユーザーの興味
${profile.interests.join(', ')}

## 除外トピック
${profile.excludeTopics?.join(', ') ?? '(なし)'}

## 除外キーワード
${profile.excludeKeywords.join(', ')}

## 優先ソース
${profile.preferredSources.join(', ')}

## 選定する記事数
最大${targetCount}件（優先度順に選定してください）

${customPrompt ? `## 追加の選定基準\n${customPrompt}\n` : ''}

## 記事リスト
${articlesList}

## 出力形式
以下のJSON形式で出力してください。必ず有効なJSONを出力してください。
記事は優先度が高い順（priority: 1が最高優先度）に並べてください。
\`\`\`json
{
  "selectedArticles": [
    {
      "id": "各記事の[ID: xxx]に記載されているIDをそのまま使用",
      "priority": 1,
      "reason": "選定理由（日本語で簡潔に）"
    }
  ]
}
\`\`\`

重要:
- idには各記事の「[ID: xxx]」に記載されている文字列をそのまま使用してください（例: "1a2b3c4"）
- 番号（1, 2, 3...）ではなく、IDフィールドの値を使ってください
- priorityは1から始まる連番で、1が最も優先度が高いことを示します
- ユーザーの興味に合致する記事を優先的に選定してください
- 除外トピック・キーワードに該当する記事は絶対に選ばないでください
- 優先ソースからの記事を優先してください
- 選定理由は具体的に記載してください
- 記事本文の取得に失敗する可能性があるため、多めに選定し優先度を付けてください`;
  }

  private async callLLM(prompt: string): Promise<string> {
    if (this.config.provider === 'gemini') {
      return this.callGemini(prompt);
    } else {
      return this.callOpenAI(prompt);
    }
  }

  private async callGemini(prompt: string): Promise<string> {
    const client = new GoogleGenAI({ apiKey: this.config.apiKey });

    const response = await client.models.generateContent({
      model: this.config.model,
      contents: [{ parts: [{ text: prompt }] }],
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts?.[0]) {
      throw new Error('Geminiからの応答が不正です');
    }

    const part = candidate.content.parts[0];
    if (!('text' in part) || !part.text) {
      throw new Error('Geminiからテキスト応答が取得できませんでした');
    }

    return part.text;
  }

  private async callOpenAI(prompt: string): Promise<string> {
    const client = new OpenAI({ apiKey: this.config.apiKey });

    const response = await client.chat.completions.create({
      model: this.config.model,
      messages: [
        {
          role: 'system',
          content: 'あなたは記事キュレーションのエキスパートです。JSONで回答してください。',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAIからの応答が不正です');
    }

    return content;
  }

  private parseResponse(responseText: string, articles: Article[]): SelectionResult {
    // JSONブロックを抽出
    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : responseText;

    if (!jsonStr) {
      this.logger.warn({ responseText }, 'LLM応答からJSONを抽出できませんでした');
      return { selected: [], reasons: new Map(), priorities: new Map() };
    }

    try {
      const parsed = JSON.parse(jsonStr) as SelectionResponse;
      const articleMap = new Map(articles.map((a) => [a.id, a]));
      // リスト番号からIDへのマッピングも作成（LLMが番号を返す場合のフォールバック用）
      const indexMap = new Map(articles.map((a, i) => [(i + 1).toString(), a]));
      const selected: Article[] = [];
      const reasons = new Map<string, string>();
      const priorities = new Map<string, number>();

      for (const item of parsed.selectedArticles) {
        const article = this.findArticle(item.id, articleMap, indexMap, articles);

        if (article) {
          selected.push(article);
          reasons.set(article.id, item.reason);
          priorities.set(article.id, item.priority ?? selected.length);
        } else {
          this.logger.warn({ id: item.id, availableIds: articles.slice(0, 5).map(a => a.id) }, '選定された記事IDが見つかりません');
        }
      }

      // 優先度順にソート
      selected.sort((a, b) => (priorities.get(a.id) ?? 999) - (priorities.get(b.id) ?? 999));

      return { selected, reasons, priorities };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error({ error: message, jsonStr }, 'LLM応答のパースに失敗');
      return { selected: [], reasons: new Map(), priorities: new Map() };
    }
  }

  /**
   * LLMが返したIDから記事を検索する
   * 複数のフォールバック戦略を使用
   */
  private findArticle(
    inputId: string,
    articleMap: Map<string, Article>,
    indexMap: Map<string, Article>,
    articles: Article[]
  ): Article | undefined {
    // IDを正規化（空白除去、小文字化）
    const normalizedId = inputId.trim().toLowerCase();

    // 1. 完全一致（元のID）
    let article = articleMap.get(inputId);
    if (article) return article;

    // 2. 完全一致（トリムしたID）
    article = articleMap.get(inputId.trim());
    if (article) return article;

    // 3. リスト番号として解釈（"1", "2", "3"...）
    article = indexMap.get(normalizedId);
    if (article) {
      this.logger.debug({ inputId, actualId: article.id }, 'リスト番号をIDに変換');
      return article;
    }

    // 4. "ID: xxx" 形式で返された場合
    const idPrefixMatch = inputId.match(/^(?:ID:\s*)?(.+)$/i);
    if (idPrefixMatch?.[1]) {
      const extractedId = idPrefixMatch[1].trim();
      article = articleMap.get(extractedId);
      if (article) {
        this.logger.debug({ inputId, actualId: article.id }, 'ID:プレフィックスを除去してマッチ');
        return article;
      }
    }

    // 5. 部分一致検索（IDの先頭部分が一致する記事を探す）
    for (const a of articles) {
      if (a.id.toLowerCase().startsWith(normalizedId) || normalizedId.startsWith(a.id.toLowerCase())) {
        this.logger.debug({ inputId, actualId: a.id }, '部分一致でマッチ');
        return a;
      }
    }

    // 6. タイトルの一部がIDとして返された場合（最終手段）
    for (const a of articles) {
      if (a.title.includes(inputId) || inputId.includes(a.title.slice(0, 20))) {
        this.logger.debug({ inputId, actualId: a.id, title: a.title }, 'タイトル部分一致でマッチ');
        return a;
      }
    }

    return undefined;
  }
}
