# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

CuraCastは、AI記事キュレーション + ポッドキャスト自動生成システム。複数ソース（RSS、はてなブックマーク、Hacker News）から記事を収集し、LLMで選定、台本生成、TTS音声化してRSSフィード配信する。

## コマンド

```bash
# 依存関係インストール
npm install

# ビルド
npm run build

# 開発モード（TypeScript直接実行）
npm run dev

# 本番実行（定期実行モード）
npm start

# 1回実行モード
npm start -- --mode=once

# 台本のみ生成（音声生成スキップ）
npm start -- --mode=once --script-only

# 起動時に即座に実行
npm start -- --run-now

# テスト実行
npm test

# 単一テストファイル実行
npm test -- src/utils/opening-topic-history.test.ts

# Lint
npm run lint

# 型チェック
npm run typecheck
```

## アーキテクチャ

### パイプライン処理フロー

```
記事収集 → AI選定 → 本文取得 → 台本生成 → TTS音声生成 → RSSフィード公開
```

### ディレクトリ構造（src/）

- `pipeline/` - メインパイプライン制御（`Pipeline`クラスが全体を統括）
- `collectors/` - 記事収集（RSS、はてな、Hacker News）
- `selectors/` - LLMによる記事選定
- `generators/` - 台本生成
- `tts/` - 音声合成（Gemini TTS / OpenAI TTS）
- `publishers/` - RSSフィード生成・Webサーバー
- `storage/` - 処理済み記事のJSON永続化
- `config/` - Zodスキーマによる設定バリデーション
- `utils/` - ロガー、テキスト分割、音声処理など

### 設定ファイル

- `config/default.yaml` - アプリケーション設定（コレクター、LLM、TTS、サーバー）
- `data/profile.yaml` - ユーザープロファイル（興味、除外トピック、台本スタイル）
- `.env` - APIキー（`GEMINI_API_KEY`）

### 出力ディレクトリ

- `output/scripts/` - 生成された台本（`.txt`）とメタデータ（`.meta.json`）
- `output/audio/` - 生成された音声ファイル（`.mp3`）
- `output/chunks/` - TTS用に分割された音声チャンク
- `data/processed.json` - 処理済み記事の記録

## 技術スタック

- TypeScript (ES2022, NodeNext modules)
- Node.js 20+
- Vitest（テスト）
- Zod（スキーマバリデーション）
- Pino（ロギング）
- Express（Webサーバー）
- ffmpeg（音声結合）

## LLMプロバイダー

- **Gemini**: 記事選定、台本生成、TTS（デフォルト）
- **OpenAI**: 代替プロバイダーとして利用可能

設定で`llmScript`を指定すると台本生成のみ別モデル（gemini-2.5-proなど）を使用可能。
