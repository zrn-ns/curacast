import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { getLogger } from './logger.js';

const logger = getLogger();

export interface FetchedArticle {
  title: string;
  content: string;
  textContent: string;
  excerpt?: string;
  byline?: string;
  siteName?: string;
}

// 記事の本文を取得
export async function fetchArticleContent(url: string): Promise<FetchedArticle | null> {
  try {
    logger.debug({ url }, '記事本文を取得中');

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CuraCast/1.0; +https://github.com/curacast)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000), // 15秒タイムアウト
    });

    if (!response.ok) {
      logger.warn({ url, status: response.status }, '記事取得失敗');
      return null;
    }

    const html = await response.text();
    const { document } = parseHTML(html);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reader = new Readability(document as any);
    const article = reader.parse();

    if (!article) {
      logger.warn({ url }, '記事のパースに失敗');
      return null;
    }

    logger.debug({ url, contentLength: article.textContent.length }, '記事本文を取得完了');

    return {
      title: article.title,
      content: article.content,
      textContent: article.textContent,
      excerpt: article.excerpt,
      byline: article.byline,
      siteName: article.siteName,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn({ url, error: message }, '記事本文の取得に失敗');
    return null;
  }
}

// 複数記事の本文を並列取得
export async function fetchMultipleArticles(
  urls: string[],
  concurrency = 3
): Promise<Map<string, FetchedArticle | null>> {
  const results = new Map<string, FetchedArticle | null>();

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url) => {
        const content = await fetchArticleContent(url);
        return { url, content };
      })
    );

    for (const { url, content } of batchResults) {
      results.set(url, content);
    }
  }

  return results;
}

// テキストを指定文字数に制限（文の途中で切らない）
export function truncateContent(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  // 最大長さ付近で文末を探す
  const truncated = text.slice(0, maxLength);
  const lastPeriod = Math.max(
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('．'),
    truncated.lastIndexOf('！'),
    truncated.lastIndexOf('？'),
    truncated.lastIndexOf('\n')
  );

  if (lastPeriod > maxLength * 0.7) {
    return truncated.slice(0, lastPeriod + 1);
  }

  return truncated + '...';
}
