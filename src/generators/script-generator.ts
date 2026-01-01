import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type { ScriptGenerator, Script } from './index.js';
import type { Article } from '../collectors/index.js';
import type { UserProfile } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { generateArticleId } from '../utils/text.js';
import { fetchArticleContent, truncateContent } from '../utils/article-fetcher.js';
import { getAvoidTopicsPrompt, addOpeningTopic } from '../utils/opening-topic-history.js';

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

    return this.generateWithContent(articlesWithContent, profile);
  }

  /**
   * 既に本文が取得済みの記事から台本を生成
   * （本文取得をPipelineで行う場合に使用）
   */
  async generateWithContent(articlesWithContent: ArticleWithContent[], profile: UserProfile): Promise<Script> {
    if (articlesWithContent.length === 0) {
      throw new Error('台本生成には少なくとも1つの記事が必要です');
    }

    const prompt = this.buildPrompt(articlesWithContent, profile);
    this.logger.debug({ articleCount: articlesWithContent.length, promptLength: prompt.length }, 'LLMによる台本生成を開始');

    try {
      const rawResponse = await this.callLLM(prompt);
      const { title: generatedTitle, script: rawScript, openingTopic } = this.parseScriptResponse(rawResponse);
      const scriptContent = this.cleanScript(rawScript);
      const today = new Date();
      const dateStr = `${today.getFullYear()}${(today.getMonth() + 1).toString().padStart(2, '0')}${today.getDate().toString().padStart(2, '0')}`;
      const randomSuffix = generateArticleId(`${Date.now()}-${Math.random()}`);

      // オープニングトピックを履歴に保存
      if (openingTopic) {
        try {
          addOpeningTopic(openingTopic, today);
          this.logger.debug({ openingTopic }, 'オープニングトピックを履歴に保存しました');
        } catch (error) {
          this.logger.warn({ error }, 'オープニングトピック履歴の保存に失敗しました');
        }
      }

      const script: Script = {
        id: `${dateStr}-${randomSuffix}`,
        title: generatedTitle || this.generateTitle(articlesWithContent, today),
        content: scriptContent,
        articles: articlesWithContent,
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

    // キャッチフレーズの取得（新形式優先、旧形式にフォールバック）
    const openingCatchphrase = narrator?.openingCatchphrase ?? narrator?.catchphrase;
    const closingCatchphrase = narrator?.closingCatchphrase ?? narrator?.catchphrase;

    const catchphraseSection = openingCatchphrase || closingCatchphrase
      ? `- キャッチフレーズ:
${openingCatchphrase ? `  - オープニング用: 「${openingCatchphrase}」` : ''}
${closingCatchphrase ? `  - エンディング用: 「${closingCatchphrase}」` : ''}`
      : '';

    const narratorSection = `## 語り部（パーソナリティ）
- 名前: ${narrator?.name ?? 'ホスト'}
- 性格: ${narrator?.personality ?? '親しみやすく、技術に詳しい'}
${catchphraseSection}

この語り部のキャラクターになりきって台本を書いてください。名前は自己紹介で使ってください。
キャッチフレーズがある場合は、オープニングとエンディングでそれぞれ適切なものを使ってください。
【重要】エンディングの順序は必ず「キャッチフレーズ → 名前（〇〇でした） → 締めの言葉」の順番にしてください。`;

    // 今日の日付を取得
    const today = new Date();
    const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
    const weekdays = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
    const weekday = weekdays[today.getDay()];

    // オープニングで避けるべきトピック（直近の履歴から）
    const avoidTopicsPrompt = getAvoidTopicsPrompt();

    const openingSection = style.includeIntro
      ? `## オープニング
今日は${dateStr}（${weekday}）です。
番組の冒頭では、日付を読み上げて挨拶してください。
オープニングトークは日付に関連した話題（今日は何の日か、季節感、時事的な話題など）を短く触れてください。
話者はAIなので、個人的な体験談や嘘の情報は含めないでください。
その後、今日紹介するトピックを軽く予告してください。
${avoidTopicsPrompt}
`
      : '';

    // 日本語の読み上げは約350文字/分
    const targetCharacters = style.maxDuration * 350;

    return `# システム指示
あなたは自動パイプラインの一部として動作しています。
出力は機械的に処理されるため、指定されたJSON形式以外の出力は一切行わないでください。
前置き、説明、確認、コメントなどは不要です。JSONのみを出力してください。

# タスク
技術系ポッドキャストの台本を作成してください。
以下の記事を元に、**${style.maxDuration}分程度**（約${targetCharacters}文字）の深掘りポッドキャスト台本を作成してください。

【重要】台本が短くなりすぎないよう注意してください。各記事について十分な深掘りを行い、目標の${style.maxDuration}分に近づけてください。

${narratorSection}

## トーン
${toneDescription}

## 言語
${style.language === 'ja' ? '日本語' : style.language}

${openingSection}

${style.includeOutro ? `## エンディング
番組の最後に締めの挨拶を含めてください。
エンディングの構成は必ず以下の順序を守ってください：
1. エンディング用キャッチフレーズ（例：「また次回、一緒にテックの世界を探検しましょう！」）
2. 名前（例：「ハルカでした。」）
3. 締めの言葉（例：「バイバイ！」）
` : ''}

${customPrompt ? `## 追加の指示\n${customPrompt}\n` : ''}

## 紹介する記事
${articlesSummary}

## 重要な指示
【最重要】**提供された全ての記事を必ず紹介してください。1つも省略しないでください。**

1. **本文の内容を具体的に紹介**: 記事のタイトルや概要だけでなく、本文に書かれている具体的な内容を詳しく紹介してください。本文を読んでいない人にも内容が伝わるように説明してください
2. **数字・データの引用**: 本文中に数字、統計、パーセンテージ、金額、日付などがあれば、必ずそれらを引用して紹介してください
3. **専門家・関係者の見解**: 本文中に専門家のコメントや関係者の発言があれば、それを紹介してください
4. **技術的な詳細**: 技術記事の場合、仕組みや手順、アーキテクチャなど本文に書かれている技術的な詳細を解説してください
5. **背景説明**: なぜこの技術/トピックが重要なのか、背景や文脈を説明してください
6. **具体例**: 可能であれば、具体的な使用例やユースケースを挙げてください
7. **考察**: 記事の内容に対するあなた自身の見解や考察を加えてください
8. **関連性**: 記事同士の関連性や、より大きなトレンドとの関係について触れてください
9. **リスナーへの問いかけ**: 時折、リスナーに考えてもらうような問いかけを入れてください

## 出力形式
- 話し言葉で自然に聞こえるように書いてください
- 専門用語には必ず簡単な説明を加えてください
- マークダウン記法（#, *, **など）は絶対に使わないでください。プレーンテキストのみで出力してください
- 「では」「さて」「ところで」などの接続詞を適度に使って、話の流れを自然にしてください
- 各記事の紹介の間には、自然な繋ぎの言葉を入れてください
- 各記事について、本文の内容を十分に紹介してから次の話題に移ってください
- 記事の紹介は「こんな記事がありました」で終わらせず、本文の内容を深く掘り下げて解説してください

## 長さの目安（重要）
- 台本全体で最低${targetCharacters}文字以上を目指してください
- 1つの記事につき最低500〜800文字程度で紹介してください
- オープニング・エンディングはそれぞれ200〜300文字程度
- 短すぎる台本は不合格です。十分な長さを確保してください

## 出力形式（厳守）
以下のJSON形式のみを出力してください。JSON以外のテキストは一切出力しないでください。

\`\`\`json
{
  "title": "【年/月/日】一言概要",
  "script": "台本の内容（話し言葉、マークダウン記法なし）",
  "openingTopic": "オープニングで触れた話題"
}
\`\`\`

### 各フィールドの説明
- **title**: 【年/月/日】形式の日付 + その日のトピックを端的に表す概要（30文字以内）
  - 例: 【2024/12/14】React脆弱性とWebGPUの進化
- **script**: 台本本文。挨拶から始まり、締めの挨拶で終わる。マークダウン記法は使用禁止。
- **openingTopic**: オープニングで触れた季節・時事の話題（10-20文字）
  - 例: 冬至、大掃除の季節、今日は〇〇の日

### 禁止事項
- JSON以外のテキスト出力（前置き、説明、確認など）
- 「承知しました」「以下に台本を作成します」などの定型句
- script内でのマークダウン記法（#, *, **など）の使用`;
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
      config: {
        maxOutputTokens: 8192,
      },
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
      max_tokens: 8192,
      messages: [
        {
          role: 'system',
          content: 'あなたは技術系ポッドキャストの台本ライターです。記事の内容を深く掘り下げ、リスナーが理解しやすい自然な話し言葉で台本を作成してください。十分な長さの台本を作成することを心がけてください。',
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

  private parseScriptResponse(response: string): { title: string; script: string; openingTopic?: string } {
    // JSONブロックを抽出
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]) as { title?: string; script?: string; openingTopic?: string };
        if (parsed.title && parsed.script) {
          return { title: parsed.title, script: parsed.script, openingTopic: parsed.openingTopic };
        }
      } catch (error) {
        this.logger.warn({ error }, 'JSON形式の応答をパースできませんでした。フォールバックします');
      }
    }

    // JSONパースに失敗した場合は、応答全体を台本として扱う
    this.logger.debug('JSON形式でない応答を受信。台本として処理します');
    return { title: '', script: response };
  }

  private generateTitle(articles: Article[], date: Date): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();

    if (articles.length === 1 && articles[0]) {
      return `【${year}/${month}/${day}】${articles[0].title}`;
    }

    return `【${year}/${month}/${day}】テック記事まとめ`;
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

  /**
   * 特別回（リクエストトピック）の台本を生成
   * Gemini Groundingを使用してGoogle検索で最新情報を取得
   */
  async generateSpecialEpisode(
    profile: UserProfile,
    topic: string
  ): Promise<Script> {
    if (!topic || topic.trim().length === 0) {
      throw new Error('トピックを指定してください');
    }

    if (this.config.provider !== 'gemini') {
      throw new Error('特別回の生成にはGeminiプロバイダーが必要です（Grounding機能を使用するため）');
    }

    const prompt = this.buildSpecialEpisodePrompt(profile, topic);
    this.logger.info({ topic, promptLength: prompt.length }, '特別回の台本生成を開始（Grounding使用）');

    try {
      const { text: rawResponse, sources } = await this.callGeminiWithGrounding(prompt);
      const { title: generatedTitle, script: rawScript } = this.parseSpecialEpisodeResponse(rawResponse);
      const scriptContent = this.cleanScript(rawScript);

      const today = new Date();
      const dateStr = `${today.getFullYear()}${(today.getMonth() + 1).toString().padStart(2, '0')}${today.getDate().toString().padStart(2, '0')}`;
      const randomSuffix = generateArticleId(`${Date.now()}-${Math.random()}`);

      const script: Script = {
        id: `${dateStr}-${randomSuffix}`,
        title: generatedTitle || this.generateSpecialEpisodeTitle(topic, today),
        content: scriptContent,
        articles: [], // 特別回は記事なし
        generatedAt: today,
        estimatedDuration: this.estimateDuration(scriptContent),
        // 特別回用フィールド
        isSpecialEpisode: true,
        requestedTopic: topic,
        sources,
      };

      this.logger.info(
        { scriptId: script.id, estimatedDuration: script.estimatedDuration, sourcesCount: sources.length },
        '特別回の台本生成が完了'
      );

      return script;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error({ error: message, topic }, '特別回の台本生成エラー');
      throw error;
    }
  }

  private buildSpecialEpisodePrompt(profile: UserProfile, topic: string): string {
    const style = profile.scriptStyle;
    const narrator = profile.narrator;

    const toneDescription = {
      casual: '親しみやすく、友達に話すような口調',
      formal: '丁寧で、ニュースキャスターのような口調',
      news: '簡潔で、事実を中心とした報道調',
    }[style.tone];

    // キャッチフレーズの取得
    const openingCatchphrase = narrator?.openingCatchphrase ?? narrator?.catchphrase;
    const closingCatchphrase = narrator?.closingCatchphrase ?? narrator?.catchphrase;

    const catchphraseSection = openingCatchphrase || closingCatchphrase
      ? `- キャッチフレーズ:
${openingCatchphrase ? `  - オープニング用: 「${openingCatchphrase}」` : ''}
${closingCatchphrase ? `  - エンディング用: 「${closingCatchphrase}」` : ''}`
      : '';

    const narratorSection = `## 語り部（パーソナリティ）
- 名前: ${narrator?.name ?? 'ホスト'}
- 性格: ${narrator?.personality ?? '親しみやすく、技術に詳しい'}
${catchphraseSection}

この語り部のキャラクターになりきって台本を書いてください。`;

    // 今日の日付を取得
    const today = new Date();
    const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
    const weekdays = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
    const weekday = weekdays[today.getDay()];

    // 日本語の読み上げは約350文字/分
    const targetCharacters = style.maxDuration * 350;

    return `# システム指示
あなたは自動パイプラインの一部として動作しています。
出力は機械的に処理されるため、指定されたJSON形式以外の出力は一切行わないでください。

# タスク
リスナーからリクエストされた以下のトピック/質問について、ポッドキャスト台本を作成してください。
**Google検索を使って最新の情報を調べ**、それを元に台本を作成してください。

## リクエスト内容
${topic}

## 指示
1. まず、リクエスト内容を分析してください：
   - 単純なキーワードか、詳細な質問/リクエストか
   - 特定の観点（比較、最新動向、解説など）が求められているか
2. **Google検索を使って最新の情報を調べてください**（これは必須です）
3. リクエストの意図に沿った台本を作成してください

## 検索して調べてほしいこと
- リクエスト内容に関連する最新ニュースや動向
- 関連する技術、製品、サービスの情報
- 専門家の見解やコメント（あれば）
- リクエストで特に言及されている観点に関する情報

${narratorSection}

## トーン
${toneDescription}

## 言語
${style.language === 'ja' ? '日本語' : style.language}

## 台本の構成
今日は${dateStr}（${weekday}）です。

1. **オープニング**:
   - 挨拶と日付の読み上げ
   - 「今日はリスナーからリクエストいただいた特別回です」
   - リクエスト内容の紹介（長い場合は要約）

2. **本文**:
   - 検索で見つけた情報を整理して紹介
   - リクエストの意図に沿った構成（解説/比較/最新動向など）
   - 具体的な数字やデータがあれば引用
   - 専門家の見解があれば紹介
   - 複数の情報源からの情報を統合

3. **エンディング**:
   - まとめ
   - リクエストへの感謝「リクエストありがとうございました」
   - 「次回のリクエストもお待ちしています」
   - エンディング用キャッチフレーズ
   - 名前（〇〇でした）
   - 締めの言葉

## 長さの目安（重要）
- 台本全体で最低${targetCharacters}文字以上を目指してください
- 短すぎる台本は不合格です。十分な長さを確保してください

## 出力形式
- 話し言葉で自然に聞こえるように書いてください
- 専門用語には必ず簡単な説明を加えてください
- マークダウン記法（#, *, **など）は絶対に使わないでください

## 出力形式（厳守）
以下のJSON形式のみを出力してください。

\`\`\`json
{
  "title": "【年/月/日】[特別回] トピックの概要（30文字以内）",
  "script": "台本の内容（話し言葉、マークダウン記法なし）"
}
\`\`\`

### 禁止事項
- JSON以外のテキスト出力
- script内でのマークダウン記法の使用`;
  }

  private async callGeminiWithGrounding(prompt: string): Promise<{ text: string; sources: string[] }> {
    const client = new GoogleGenAI({ apiKey: this.config.apiKey });

    const response = await client.models.generateContent({
      model: this.config.model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 8192,
        tools: [{ googleSearch: {} }],
      },
    });

    const candidate = response.candidates?.[0];

    // レスポンスが空またはブロックされた場合の詳細なエラーハンドリング
    if (!candidate) {
      // promptFeedbackをチェック（コンテンツブロックの理由）
      const promptFeedback = response.promptFeedback;
      if (promptFeedback?.blockReason) {
        throw new Error(`リクエストがブロックされました: ${promptFeedback.blockReason}`);
      }
      throw new Error('Gemini Groundingからの応答が空です');
    }

    // finishReasonをチェック
    const finishReason = candidate.finishReason;
    if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
      this.logger.warn({ finishReason }, 'Gemini応答が異常終了');
      if (finishReason === 'SAFETY') {
        throw new Error('安全性フィルターにより応答が制限されました。トピックを変更してお試しください');
      }
      if (finishReason === 'RECITATION') {
        throw new Error('引用制限により応答が制限されました');
      }
      throw new Error(`応答が異常終了しました: ${finishReason}`);
    }

    if (!candidate.content?.parts?.[0]) {
      throw new Error('Gemini Groundingからの応答コンテンツが空です');
    }

    const part = candidate.content.parts[0];
    if (!('text' in part) || !part.text) {
      throw new Error('Gemini Groundingからテキスト応答が取得できませんでした');
    }

    // Grounding メタデータから参照元URLを抽出
    const sources: string[] = [];
    const groundingMetadata = candidate.groundingMetadata;
    if (groundingMetadata?.groundingChunks) {
      for (const chunk of groundingMetadata.groundingChunks) {
        if (chunk.web?.uri) {
          sources.push(chunk.web.uri);
        }
      }
    }

    this.logger.debug({ sourcesCount: sources.length }, 'Grounding検索結果を取得');

    return { text: part.text, sources };
  }

  private parseSpecialEpisodeResponse(response: string): { title: string; script: string } {
    // JSONブロックを抽出
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]) as { title?: string; script?: string };
        if (parsed.title && parsed.script) {
          return { title: parsed.title, script: parsed.script };
        }
      } catch (error) {
        this.logger.warn({ error }, '特別回のJSON応答をパースできませんでした。フォールバックします');
      }
    }

    // JSONパースに失敗した場合
    this.logger.debug('JSON形式でない応答を受信。台本として処理します');
    return { title: '', script: response };
  }

  private generateSpecialEpisodeTitle(topic: string, date: Date): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();

    // トピックが長い場合は30文字に切り詰める
    const shortTopic = topic.length > 25 ? topic.slice(0, 25) + '...' : topic;

    return `【${year}/${month}/${day}】[特別回] ${shortTopic}`;
  }
}
