import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type { ScriptGenerator, Script } from './index.js';
import type { Article } from '../collectors/index.js';
import type { UserProfile } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { generateArticleId } from '../utils/text.js';

export interface LLMScriptGeneratorConfig {
  provider: 'gemini' | 'openai';
  model: string;
  apiKey: string;
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

    const prompt = this.buildPrompt(articles, profile);
    this.logger.debug({ articleCount: articles.length }, 'LLMによる台本生成を開始');

    try {
      const scriptContent = await this.callLLM(prompt);
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

  private buildPrompt(articles: Article[], profile: UserProfile): string {
    const style = profile.scriptStyle;
    const customPrompt = profile.customPrompts?.scriptGeneration ?? '';

    const articlesSummary = articles
      .map(
        (a, i) =>
          `### 記事${i + 1}: ${a.title}
ソース: ${a.sourceName ?? a.source}
URL: ${a.url}
概要: ${a.description ?? '(なし)'}`
      )
      .join('\n\n');

    const toneDescription = {
      casual: '親しみやすく、友達に話すような口調',
      formal: '丁寧で、ニュースキャスターのような口調',
      news: '簡潔で、事実を中心とした報道調',
    }[style.tone];

    return `あなたはポッドキャストの台本ライターです。
以下の記事を元に、${style.maxDuration}分程度のポッドキャスト台本を作成してください。

## トーン
${toneDescription}

## 言語
${style.language === 'ja' ? '日本語' : style.language}

${style.includeIntro ? '## オープニング\n番組の冒頭に挨拶と今日のトピック紹介を含めてください。\n' : ''}

${style.includeOutro ? '## エンディング\n番組の最後に締めの挨拶を含めてください。\n' : ''}

${customPrompt ? `## 追加の指示\n${customPrompt}\n` : ''}

## 紹介する記事
${articlesSummary}

## 出力形式
- 話し言葉で自然に聞こえるように書いてください
- 専門用語には簡単な説明を加えてください
- 記事の内容を要約しつつ、リスナーが興味を持てるように紹介してください
- マークダウン記法は使わず、プレーンテキストで出力してください
- 「では」「さて」などの接続詞を適度に使って、話の流れを自然にしてください

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
          content: 'あなたはポッドキャストの台本ライターです。自然な話し言葉で台本を作成してください。',
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
}
