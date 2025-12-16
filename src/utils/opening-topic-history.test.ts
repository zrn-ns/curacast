import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  loadOpeningTopicHistory,
  saveOpeningTopicHistory,
  addOpeningTopic,
  getRecentTopics,
  getAvoidTopicsPrompt,
} from './opening-topic-history.js';

describe('opening-topic-history', () => {
  let tempDir: string;
  let historyPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'curacast-test-'));
    historyPath = path.join(tempDir, 'opening-topic-history.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('loadOpeningTopicHistory', () => {
    it('存在しないファイルの場合、空の履歴を返す', () => {
      const history = loadOpeningTopicHistory(historyPath);
      expect(history.topics).toEqual([]);
    });

    it('既存のファイルから履歴を読み込める', async () => {
      const testHistory = {
        topics: [
          { date: '2025-12-14', topic: 'クリスマスイルミネーション' },
          { date: '2025-12-15', topic: '冬至が近づいています' },
        ],
      };
      await fs.writeFile(historyPath, JSON.stringify(testHistory), 'utf-8');

      const history = loadOpeningTopicHistory(historyPath);
      expect(history.topics).toHaveLength(2);
      expect(history.topics[0]?.topic).toBe('クリスマスイルミネーション');
    });
  });

  describe('saveOpeningTopicHistory', () => {
    it('履歴をファイルに保存できる', async () => {
      const history = {
        topics: [{ date: '2025-12-15', topic: '年末の大掃除' }],
      };

      saveOpeningTopicHistory(history, historyPath);

      const content = await fs.readFile(historyPath, 'utf-8');
      const saved = JSON.parse(content);
      expect(saved.topics).toHaveLength(1);
      expect(saved.topics[0].topic).toBe('年末の大掃除');
    });

    it('最大件数を超えた場合、古いものを削除する', async () => {
      const topics = Array.from({ length: 20 }, (_, i) => ({
        date: `2025-12-${String(i + 1).padStart(2, '0')}`,
        topic: `トピック${i + 1}`,
      }));
      const history = { topics };

      saveOpeningTopicHistory(history, historyPath);

      const loaded = loadOpeningTopicHistory(historyPath);
      // 最大14件に制限される
      expect(loaded.topics.length).toBe(14);
      // 最新のものが保持される
      expect(loaded.topics[loaded.topics.length - 1]?.topic).toBe('トピック20');
    });
  });

  describe('addOpeningTopic', () => {
    it('新しいトピックを追加できる', () => {
      const date = new Date('2025-12-15');
      addOpeningTopic('今日は観光バス記念日', date, historyPath);

      const history = loadOpeningTopicHistory(historyPath);
      expect(history.topics).toHaveLength(1);
      expect(history.topics[0]?.topic).toBe('今日は観光バス記念日');
      expect(history.topics[0]?.date).toBe('2025-12-15');
    });

    it('同じ日付のトピックは更新される', () => {
      const date = new Date('2025-12-15');
      addOpeningTopic('トピックA', date, historyPath);
      addOpeningTopic('トピックB', date, historyPath);

      const history = loadOpeningTopicHistory(historyPath);
      expect(history.topics).toHaveLength(1);
      expect(history.topics[0]?.topic).toBe('トピックB');
    });
  });

  describe('getRecentTopics', () => {
    it('直近のトピック一覧を取得できる', async () => {
      const topics = Array.from({ length: 10 }, (_, i) => ({
        date: `2025-12-${String(i + 1).padStart(2, '0')}`,
        topic: `トピック${i + 1}`,
      }));
      await fs.writeFile(historyPath, JSON.stringify({ topics }), 'utf-8');

      const recent = getRecentTopics(5, historyPath);
      expect(recent).toHaveLength(5);
      // 最新5件が取得される
      expect(recent).toContain('トピック10');
      expect(recent).toContain('トピック6');
      expect(recent).not.toContain('トピック5');
    });

    it('履歴が空の場合は空配列を返す', () => {
      const recent = getRecentTopics(5, historyPath);
      expect(recent).toEqual([]);
    });
  });

  describe('getAvoidTopicsPrompt', () => {
    it('履歴がある場合、避けるべきトピックのプロンプトを生成する', async () => {
      const topics = [
        { date: '2025-12-14', topic: 'クリスマスイルミネーション' },
        { date: '2025-12-15', topic: '年末の大掃除' },
      ];
      await fs.writeFile(historyPath, JSON.stringify({ topics }), 'utf-8');

      const prompt = getAvoidTopicsPrompt(historyPath);

      expect(prompt).toContain('クリスマスイルミネーション');
      expect(prompt).toContain('年末の大掃除');
      expect(prompt).toContain('避けてください');
    });

    it('履歴が空の場合は空文字を返す', () => {
      const prompt = getAvoidTopicsPrompt(historyPath);
      expect(prompt).toBe('');
    });
  });
});
