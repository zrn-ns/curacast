// テキスト分割の最大サイズ（Gemini TTSの4000バイト制限に対応、日本語1文字≒3バイト）
const DEFAULT_MAX_CHUNK_SIZE = 1400;

export interface SplitOptions {
  maxChunkSize?: number;
}

// テキストを適切な長さのチャンクに分割
export function splitText(text: string, options: SplitOptions = {}): string[] {
  const maxChunkSize = options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;

  // テキストが空の場合は空の配列を返す
  if (!text || text.trim().length === 0) {
    return [];
  }

  // テキストを段落で分割
  const paragraphs = text.split('\n\n').filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    // 段落が単独でチャンクサイズを超える場合は、さらに分割
    if (paragraph.length > maxChunkSize) {
      // 後読みアサーションで句読点を保持して分割
      const sentences = paragraph.split(/(?<=[。．！？])/).filter((s) => s.trim().length > 0);
      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > maxChunkSize) {
          if (currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = '';
          }
          // 長い文章は単独でチャンクにする（句読点は既に含まれている）
          chunks.push(sentence.trim());
        } else {
          currentChunk += sentence;
        }
      }
    } else if (currentChunk.length + paragraph.length > maxChunkSize) {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// URLからIDを生成（ハッシュ）
export function generateArticleId(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // 32bit整数に変換
  }
  return Math.abs(hash).toString(36);
}

// テキストを指定文字数で切り詰める
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + '...';
}

// HTMLタグを除去
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

// Markdownの基本的なフォーマットを除去
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/#{1,6}\s/g, '') // 見出し
    .replace(/\*\*(.+?)\*\*/g, '$1') // 太字
    .replace(/\*(.+?)\*/g, '$1') // イタリック
    .replace(/`(.+?)`/g, '$1') // インラインコード
    .replace(/```[\s\S]*?```/g, '') // コードブロック
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // リンク
    .replace(/!\[.*?\]\(.+?\)/g, '') // 画像
    .replace(/^\s*[-*+]\s/gm, '') // リスト
    .replace(/^\s*\d+\.\s/gm, '') // 番号付きリスト
    .replace(/^\s*>\s/gm, '') // 引用
    .trim();
}
