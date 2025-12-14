import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type { ScriptGenerator, Script } from './index.js';
import type { Article } from '../collectors/index.js';
import type { UserProfile } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { generateArticleId } from '../utils/text.js';
import { fetchArticleContent, truncateContent } from '../utils/article-fetcher.js';

export interface LLMScriptGeneratorConfig {
  provider: 'gemini' | 'openai';
  model: string;
  apiKey: string;
}

// 記事と取得した本文
interface ArticleWithContent extends Article {
  fetchedContent?: string;
}

export class LLMScriptGenerator implements ScriptGenerator {
  private config: LLMScriptGeneratorConfig;
  private logger = getLogger();

  constructor(config: LLMScriptGeneratorConfig) {
    this.config = config;
  }

  async generate(articles: Article[], profile: UserProfile): Promise<Script> {
    if (articles.length === 0) {
      throw new Error('台本生成には少なくとも1つの記事が必要です');
    }

    // 記事の本文を取得
    this.logger.info({ count: articles.length }, '記事本文を取得中...');
    const articlesWithContent = await this.fetchArticleContents(articles);

    const prompt = this.buildPrompt(articlesWithContent, profile);
    this.logger.debug({ articleCount: articles.length, promptLength: prompt.length }, 'LLMによる台本生成を開始');

    try {
      const rawScript = await this.callLLM(prompt);
      const scriptContent = this.cleanScript(rawScript);
      const today = new Date();
      const dateStr = `${today.getFullYear()}${(today.getMonth() + 1).toString().padStart(2, '0')}${today.getDate().toString().padStart(2, '0')}`;

      const script: Script = {
        id: generateArticleId(`script-${dateStr}-${Date.now()}`),
        title: this.generateTitle(articles, today),
        content: scriptContent,
        articles,
        generatedAt: today,
        estimatedDuration: this.estimateDuration(scriptContent),
      };

      this.logger.info(
        { scriptId: script.id, estimatedDuration: script.estimatedDuration },
        'LLMによる台本生成が完了'
      );

      return script;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error({ error: message }, 'LLM台本生成エラー');
      throw error;
    }
  }

  private async fetchArticleContents(articles: Article[]): Promise<ArticleWithContent[]> {
    const results: ArticleWithContent[] = [];

    // 並列で記事本文を取得（3件ずつ）
    for (let i = 0; i < articles.length; i += 3) {
      const batch = articles.slice(i, i + 3);
      const batchResults = await Promise.all(
        batch.map(async (article) => {
          const fetched = await fetchArticleContent(article.url);
          return {
            ...article,
            fetchedContent: fetched?.textContent
              ? truncateContent(fetched.textContent, 5000) // 各記事最大5000文字
              : undefined,
          };
        })
      );
      results.push(...batchResults);
    }

    const successCount = results.filter((r) => r.fetchedContent).length;
    this.logger.info(
      { total: articles.length, fetched: successCount },
      '記事本文の取得完了'
    );

    return results;
  }

  private buildPrompt(articles: ArticleWithContent[], profile: UserProfile): string {
    const style = profile.scriptStyle;
    const narrator = profile.narrator;
    const customPrompt = profile.customPrompts?.scriptGeneration ?? '';

    const articlesSummary = articles
      .map((a, i) => {
        const hasContent = !!a.fetchedContent;
        return `### 記事${i + 1}: ${a.title}
ソース: ${a.sourceName ?? a.source}
URL: ${a.url}

${hasContent ? `【記事本文】\n${a.fetchedContent}` : `【概要のみ】\n${a.description ?? '(なし)'}`}
`;
      })
      .join('\n---\n\n');

    const toneDescription = {
      casual: '親しみやすく、友達に話すような口調',
      formal: '丁寧で、ニュースキャスターのような口調',
      news: '簡潔で、事実を中心とした報道調',
    }[style.tone];

    const narratorSection = `## 語り部（パーソナリティ）
- 名前: ${narrator?.name ?? 'ホスト'}
- 性格: ${narrator?.personality ?? '親しみやすく、技術に詳しい'}
${narrator?.catchphrase ? `- 口癖・決め台詞: 「${narrator.catchphrase}」（適宜使ってください）` : ''}

この語り部のキャラクターになりきって台本を書いてください。名前は自己紹介で使ってください。`;

    // 今日の日付を取得
    const today = new Date();
    const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
    const weekdays = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
    const weekday = weekdays[today.getDay()];

    const openingSection = style.includeIntro
      ? `## オープニング
今日は${dateStr}（${weekday}）です。
番組の冒頭では、日付を読み上げて挨拶し、簡単なオープニングトークをしてください。
その後、今日紹介するトピックを軽く予告してください。
`
      : '';

    return `あなたは技術系ポッドキャストの台本ライターです。
以下の記事を元に、${style.maxDuration}分程度の深掘りポッドキャスト台本を作成してください。

${narratorSection}

## トーン
${toneDescription}

## 言語
${style.language === 'ja' ? '日本語' : style.language}

${openingSection}

${style.includeOutro ? '## エンディング\n番組の最後に締めの挨拶を含めてください。\n' : ''}

${customPrompt ? `## 追加の指示\n${customPrompt}\n` : ''}

## 紹介する記事
${articlesSummary}

## 重要な指示
1. **深掘り**: 各記事について、単なる紹介ではなく、内容を深く掘り下げて解説してください
2. **背景説明**: なぜこの技術/トピックが重要なのか、背景や文脈を説明してください
3. **具体例**: 可能であれば、具体的な使用例やユースケースを挙げてください
4. **考察**: 記事の内容に対するあなた自身の見解や考察を加えてください
5. **関連性**: 記事同士の関連性や、より大きなトレンドとの関係について触れてください
6. **リスナーへの問いかけ**: 時折、リスナーに考えてもらうような問いかけを入れてください

## 出力形式
- 話し言葉で自然に聞こえるように書いてください
- 専門用語には必ず簡単な説明を加えてください
- マークダウン記法（#, *, **など）は絶対に使わないでください。プレーンテキストのみで出力してください
- 「では」「さて」「ところで」などの接続詞を適度に使って、話の流れを自然にしてください
- 各記事の紹介の間には、自然な繋ぎの言葉を入れてください
- 各記事について十分な時間をかけて深く掘り下げてください。急いで次の話題に移る必要はありません

## 重要な注意
- 「承知しました」「以下に台本を作成します」などの前置きは絶対に含めないでください
- 台本の内容のみを出力してください。説明や注釈は不要です
- 挨拶から始めて、締めの挨拶で終わってください

台本を出力してください:`;
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
          content: 'あなたは技術系ポッドキャストの台本ライターです。記事の内容を深く掘り下げ、リスナーが理解しやすい自然な話し言葉で台本を作成してください。',
        },
        { role: 'user', content: prompt },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAIからの応答が不正です');
    }

    return content;
  }

  private generateTitle(articles: Article[], date: Date): string {
    const dateStr = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;

    if (articles.length === 1 && articles[0]) {
      return `${dateStr}の話題: ${articles[0].title}`;
    }

    return `${dateStr}のテック記事まとめ`;
  }

  private estimateDuration(content: string): number {
    // 日本語の読み上げ速度は約300-400文字/分
    // 余裕を持って350文字/分で計算
    const charactersPerMinute = 350;
    return Math.ceil(content.length / charactersPerMinute);
  }

  private cleanScript(script: string): string {
    let cleaned = script;

    // LLMの前置き・後置きを除去
    cleaned = cleaned.replace(/^(はい、|承知|以下に|了解).*?(。|：|:)\n*/i, '');
    cleaned = cleaned.replace(/^---+\n*/gm, '');

    // マークダウン記法を除去
    cleaned = cleaned.replace(/^#{1,6}\s*/gm, ''); // 見出し
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1'); // 太字
    cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1'); // 斜体
    cleaned = cleaned.replace(/^[\*\-]\s+/gm, '・'); // リスト記号を「・」に変換
    cleaned = cleaned.replace(/^\d+\.\s+/gm, ''); // 番号付きリスト
    cleaned = cleaned.replace(/`([^`]+)`/g, '$1'); // インラインコード
    cleaned = cleaned.replace(/```[\s\S]*?```/g, ''); // コードブロック

    // 連続する空行を1つに
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
  }
}
