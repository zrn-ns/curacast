import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchArticleContent, truncateContent } from './article-fetcher.js';

describe('article-fetcher', () => {
  describe('truncateContent', () => {
    it('指定文字数以下のテキストはそのまま返す', () => {
      const text = 'これは短いテキストです。';
      expect(truncateContent(text, 100)).toBe(text);
    });

    it('指定文字数を超えるテキストは句点で切る', () => {
      const text = 'これは最初の文です。これは2番目の文です。これは3番目の文です。';
      // 25文字: "これは最初の文です。これは2番目の文です。" (23文字) まで入り、句点で切れる
      const result = truncateContent(text, 25);
      expect(result).toBe('これは最初の文です。これは2番目の文です。');
    });

    it('句点がない場合は...を追加する', () => {
      const text = 'これは句点のないとても長いテキストです';
      const result = truncateContent(text, 10);
      // 10文字で切って...を追加
      expect(result).toBe('これは句点のないとて...');
    });
  });

  describe('extractYahooNewsContent (via fetchArticleContent)', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      // fetchをモック
      global.fetch = vi.fn();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('Yahoo!ニュースの__PRELOADED_STATE__から本文を抽出できる（articleDetail構造）', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>テスト記事</title></head>
        <body>
        <script>
        __PRELOADED_STATE__ = {
          "pageData": {
            "title": "テスト記事タイトル"
          },
          "articleDetail": {
            "paragraphs": [
              {
                "textDetails": [
                  {
                    "paragraphItems": [
                      { "type": "text", "text": "これは最初の段落です。" },
                      { "type": "text", "text": "これは2番目の段落です。" }
                    ]
                  }
                ]
              },
              {
                "textDetails": [
                  {
                    "paragraphItems": [
                      { "type": "text", "text": "これは3番目の段落です。" }
                    ]
                  }
                ]
              }
            ]
          }
        };
        </script>
        </body>
        </html>
      `;

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockHtml),
      } as Response);

      const result = await fetchArticleContent(
        'https://news.yahoo.co.jp/articles/test123'
      );

      expect(result).not.toBeNull();
      expect(result?.title).toBe('テスト記事タイトル');
      expect(result?.textContent).toContain('これは最初の段落です。');
      expect(result?.textContent).toContain('これは2番目の段落です。');
      expect(result?.textContent).toContain('これは3番目の段落です。');
      expect(result?.siteName).toBe('Yahoo!ニュース');
    });

    it('__PRELOADED_STATE__がない場合はReadabilityにフォールバックする', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>テスト記事</title></head>
        <body>
        <article>
          <h1>フォールバック記事</h1>
          <p>これはReadabilityで抽出される本文です。</p>
        </article>
        </body>
        </html>
      `;

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockHtml),
      } as Response);

      const result = await fetchArticleContent(
        'https://news.yahoo.co.jp/articles/test123'
      );

      expect(result).not.toBeNull();
      // Readabilityがパースできた場合の確認
      expect(result?.textContent).toBeTruthy();
    });

    it('pickupページからarticlesページを解決する', async () => {
      const pickupHtml = `
        <!DOCTYPE html>
        <html>
        <body>
        <a href="https://news.yahoo.co.jp/articles/resolved123">記事リンク</a>
        </body>
        </html>
      `;

      const articleHtml = `
        <!DOCTYPE html>
        <html>
        <body>
        <script>
        __PRELOADED_STATE__ = {
          "pageData": {
            "title": "解決された記事",
            "paragraphs": [
              {
                "textDetails": [
                  {
                    "paragraphItems": [
                      { "type": "text", "text": "解決された記事の本文です。" }
                    ]
                  }
                ]
              }
            ]
          }
        };
        </script>
        </body>
        </html>
      `;

      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(pickupHtml),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(articleHtml),
        } as Response);

      const result = await fetchArticleContent(
        'https://news.yahoo.co.jp/pickup/12345'
      );

      expect(result).not.toBeNull();
      expect(result?.title).toBe('解決された記事');
      expect(result?.textContent).toContain('解決された記事の本文です。');
    });

    it('空の段落は無視される', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
        <body>
        <script>
        __PRELOADED_STATE__ = {
          "pageData": {
            "title": "テスト",
            "paragraphs": [
              {
                "textDetails": [
                  {
                    "paragraphItems": [
                      { "type": "text", "text": "  " },
                      { "type": "text", "text": "有効な段落" },
                      { "type": "image", "url": "image.jpg" }
                    ]
                  }
                ]
              }
            ]
          }
        };
        </script>
        </body>
        </html>
      `;

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockHtml),
      } as Response);

      const result = await fetchArticleContent(
        'https://news.yahoo.co.jp/articles/test'
      );

      expect(result?.textContent).toBe('有効な段落');
    });
  });
});
