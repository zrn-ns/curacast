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

// Yahoo!ニュースのpickupページから実際の記事URLを抽出
async function resolveYahooNewsUrl(pickupUrl: string): Promise<string | null> {
  try {
    const response = await fetch(pickupUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CuraCast/1.0; +https://github.com/curacast)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    // /articles/ URLを抽出
    const match = html.match(/href="(https:\/\/news\.yahoo\.co\.jp\/articles\/[^"]+)"/);
    if (match?.[1]) {
      // クエリパラメータと画像URLを除外
      const articleUrl = match[1].split('?')[0];
      if (!articleUrl?.includes('/images/')) {
        return articleUrl ?? null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Yahoo!ニュースの__PRELOADED_STATE__から記事本文を抽出
function extractYahooNewsContent(html: string): FetchedArticle | null {
  try {
    // __PRELOADED_STATE__の開始位置を探す
    const preloadStart = html.indexOf('__PRELOADED_STATE__');
    if (preloadStart === -1) {
      logger.debug('Yahoo!ニュース: __PRELOADED_STATE__が見つかりません');
      return null;
    }

    // 次の</script>までを取得
    const scriptEnd = html.indexOf('</script>', preloadStart);
    if (scriptEnd === -1) {
      logger.debug('Yahoo!ニュース: </script>が見つかりません');
      return null;
    }

    const content = html.slice(preloadStart, scriptEnd);
    const eqIdx = content.indexOf('=');
    if (eqIdx === -1) {
      logger.debug('Yahoo!ニュース: =が見つかりません');
      return null;
    }

    let jsonPart = content.slice(eqIdx + 1).trim();
    // 末尾のセミコロンを除去
    if (jsonPart.endsWith(';')) {
      jsonPart = jsonPart.slice(0, -1);
    }

    const preloadedState = JSON.parse(jsonPart);

    // タイトルを取得（pageDataから）
    const pageData = preloadedState?.pageData;
    const title = pageData?.title ?? '';

    // 本文を抽出: articleDetail.paragraphs を優先、なければ pageData.paragraphs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let paragraphsData: any[] = [];

    // articleDetailからparagraphsを取得（新しい構造）
    const articleDetail = preloadedState?.articleDetail;
    if (articleDetail?.paragraphs && articleDetail.paragraphs.length > 0) {
      paragraphsData = articleDetail.paragraphs;
      logger.debug('Yahoo!ニュース: articleDetailからparagraphsを取得');
    } else if (pageData?.paragraphs && pageData.paragraphs.length > 0) {
      // フォールバック: pageDataからparagraphsを取得（古い構造）
      paragraphsData = pageData.paragraphs;
      logger.debug('Yahoo!ニュース: pageDataからparagraphsを取得');
    }

    if (paragraphsData.length === 0) {
      logger.debug('Yahoo!ニュース: paragraphsが見つかりません');
      return null;
    }

    // paragraphs[].textDetails[].paragraphItems[].text を結合
    const paragraphs: string[] = [];
    for (const paragraph of paragraphsData) {
      const textDetails = paragraph?.textDetails ?? [];
      for (const textDetail of textDetails) {
        const paragraphItems = textDetail?.paragraphItems ?? [];
        for (const item of paragraphItems) {
          if (item?.type === 'text' && item?.text) {
            // 改行を整理して追加
            const text = item.text.trim();
            if (text) {
              paragraphs.push(text);
            }
          }
        }
      }
    }

    if (paragraphs.length === 0) {
      logger.debug('Yahoo!ニュース: 本文段落が見つかりません');
      return null;
    }

    const textContent = paragraphs.join('\n\n');

    logger.debug(
      { title, contentLength: textContent.length },
      'Yahoo!ニュース記事本文を__PRELOADED_STATE__から抽出'
    );

    return {
      title,
      content: `<article>${paragraphs.map((p) => `<p>${p}</p>`).join('')}</article>`,
      textContent,
      excerpt: textContent.slice(0, 200),
      siteName: 'Yahoo!ニュース',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.debug({ error: message }, 'Yahoo!ニュース__PRELOADED_STATE__のパースに失敗');
    return null;
  }
}

// 記事の本文を取得
export async function fetchArticleContent(url: string): Promise<FetchedArticle | null> {
  try {
    let targetUrl = url;

    // Yahoo!ニュースのpickupページの場合は実際の記事URLを取得
    if (url.includes('news.yahoo.co.jp/pickup/')) {
      logger.debug({ url }, 'Yahoo!ニュースpickupページから記事URLを取得中');
      const articleUrl = await resolveYahooNewsUrl(url);
      if (articleUrl) {
        targetUrl = articleUrl;
        logger.debug({ originalUrl: url, resolvedUrl: targetUrl }, 'Yahoo!ニュース記事URLを解決');
      } else {
        logger.warn({ url }, 'Yahoo!ニュース記事URLの解決に失敗');
      }
    }

    logger.debug({ url: targetUrl }, '記事本文を取得中');

    const response = await fetch(targetUrl, {
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

    // Yahoo!ニュースの記事ページの場合は__PRELOADED_STATE__から抽出を試みる
    if (targetUrl.includes('news.yahoo.co.jp/articles/')) {
      const yahooArticle = extractYahooNewsContent(html);
      if (yahooArticle) {
        logger.debug(
          { url: targetUrl, contentLength: yahooArticle.textContent.length },
          'Yahoo!ニュース記事本文を取得完了'
        );
        return yahooArticle;
      }
      // 抽出に失敗した場合はReadabilityにフォールバック
      logger.debug({ url: targetUrl }, 'Yahoo!ニュース__PRELOADED_STATE__抽出に失敗、Readabilityにフォールバック');
    }

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
