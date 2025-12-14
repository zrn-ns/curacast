import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { JsonStorage } from './json-storage.js';

describe('JsonStorage', () => {
  let tempDir: string;
  let storage: JsonStorage;

  beforeEach(async () => {
    // テスト用の一時ディレクトリを作成
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'curacast-test-'));
    storage = new JsonStorage(tempDir);
    await storage.load();
  });

  afterEach(async () => {
    // テスト後に一時ディレクトリを削除
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('失敗URL管理', () => {
    it('URLを失敗としてマークできる', async () => {
      const url = 'https://example.com/article1';
      const error = 'タイムアウト';

      await storage.markUrlAsFailed(url, error);

      expect(storage.isUrlFailed(url)).toBe(true);
    });

    it('失敗していないURLはfalseを返す', () => {
      const url = 'https://example.com/new-article';

      expect(storage.isUrlFailed(url)).toBe(false);
    });

    it('失敗URLリストを取得できる', async () => {
      await storage.markUrlAsFailed('https://example.com/1', 'エラー1');
      await storage.markUrlAsFailed('https://example.com/2', 'エラー2');

      const failedUrls = storage.getFailedUrls();

      expect(failedUrls).toHaveLength(2);
      expect(failedUrls.map((f) => f.url)).toContain('https://example.com/1');
      expect(failedUrls.map((f) => f.url)).toContain('https://example.com/2');
    });

    it('同じURLは重複して登録されない', async () => {
      const url = 'https://example.com/article1';

      await storage.markUrlAsFailed(url, 'エラー1');
      await storage.markUrlAsFailed(url, 'エラー2');

      const failedUrls = storage.getFailedUrls();
      expect(failedUrls).toHaveLength(1);
      // 2回目のエラーで更新される
      expect(failedUrls[0]?.error).toBe('エラー2');
    });

    it('一定期間経過した失敗URLは再試行可能になる', async () => {
      const url = 'https://example.com/old-article';
      await storage.markUrlAsFailed(url, 'エラー');

      // デフォルトでは7日間は失敗扱い
      expect(storage.isUrlFailed(url)).toBe(true);

      // 8日前の失敗は再試行可能
      // テスト用に古い日時を直接設定する必要がある
      const failedUrls = storage.getFailedUrls();
      const failedEntry = failedUrls.find((f) => f.url === url);
      if (failedEntry) {
        const oldDate = new Date();
        oldDate.setDate(oldDate.getDate() - 8);
        failedEntry.failedAt = oldDate.toISOString();
      }

      expect(storage.isUrlFailed(url)).toBe(false);
    });

    it('失敗URLの保持期間を設定できる', async () => {
      const url = 'https://example.com/article1';
      await storage.markUrlAsFailed(url, 'エラー');

      // 保持期間を3日に設定
      const retentionDays = 3;

      // 4日前の失敗は再試行可能
      const failedUrls = storage.getFailedUrls();
      const failedEntry = failedUrls.find((f) => f.url === url);
      if (failedEntry) {
        const oldDate = new Date();
        oldDate.setDate(oldDate.getDate() - 4);
        failedEntry.failedAt = oldDate.toISOString();
      }

      expect(storage.isUrlFailed(url, retentionDays)).toBe(false);
    });

    it('古い失敗URLをクリーンアップできる', async () => {
      await storage.markUrlAsFailed('https://example.com/old', 'エラー');
      await storage.markUrlAsFailed('https://example.com/new', 'エラー');

      // old-articleを古い日時に変更
      const failedUrls = storage.getFailedUrls();
      const oldEntry = failedUrls.find((f) => f.url === 'https://example.com/old');
      if (oldEntry) {
        const oldDate = new Date();
        oldDate.setDate(oldDate.getDate() - 10);
        oldEntry.failedAt = oldDate.toISOString();
      }

      // 7日以上古いものをクリーンアップ
      const removed = await storage.cleanupFailedUrls(7);

      expect(removed).toBe(1);
      expect(storage.getFailedUrls()).toHaveLength(1);
      expect(storage.isUrlFailed('https://example.com/new')).toBe(true);
    });

    it('データはファイルに永続化される', async () => {
      await storage.markUrlAsFailed('https://example.com/article', 'エラー');

      // 新しいインスタンスを作成して読み込み
      const newStorage = new JsonStorage(tempDir);
      await newStorage.load();

      expect(newStorage.isUrlFailed('https://example.com/article')).toBe(true);
    });
  });
});
