# CuraCast

AI記事キュレーション + ポッドキャスト自動生成システム

## 概要

CuraCastは、複数のソースから記事を自動収集し、AIで興味に合う記事を選定、ポッドキャスト台本を生成して音声化するシステムです。

## 機能

- **記事収集**: RSS、はてなブックマーク、Hacker Newsから自動収集
- **AI記事選定**: LLM（Gemini/OpenAI）でユーザーの興味に合う記事を選定
- **台本生成**: 選定記事からポッドキャスト向け台本を自動生成
- **音声生成**: Gemini TTS または OpenAI TTSで音声化
- **配信**: RSSフィード（Podcast）として配信

## 必要条件

- Node.js 20以上
- Gemini API キー または OpenAI API キー

## セットアップ

### 1. リポジトリのクローン

```bash
git clone [repository-url]
cd curacast
```

### 2. 依存関係のインストール

```bash
npm install
```

### 3. 環境変数の設定

`.env`ファイルを作成:

```bash
cp .env.example .env
```

`.env`を編集してAPIキーを設定:

```
GEMINI_API_KEY=your_gemini_api_key_here
```

### 4. 興味プロファイルの設定

`data/profile.yaml`を編集して、興味のあるトピックを設定:

```yaml
interests:
  - "iOS/Swift開発"
  - "TypeScript/JavaScript"
  - "AI/機械学習"

excludeKeywords:
  - "PR"
  - "広告"

maxArticlesPerRun: 5
```

## 起動方法

### ビルド

```bash
npm run build
```

### 1回実行モード

記事を収集・選定・音声化を1回実行:

```bash
npm start -- --mode=once
```

### 定期実行モード（デフォルト）

設定されたcron式に従って定期実行:

```bash
npm start
```

起動時に即座に実行する場合:

```bash
npm start -- --run-now
```

### 開発モード

TypeScriptを直接実行:

```bash
npm run dev
```

## Docker

### Docker Composeで起動

```bash
# .envファイルを作成
cp .env.example .env
# APIキーを設定

# 起動
docker compose up -d

# ログ確認
docker compose logs -f

# 停止
docker compose down
```

### Docker Hubからイメージを取得

```bash
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/output:/app/output \
  -e GEMINI_API_KEY=your_api_key_here \
  username/curacast:latest
```

## 設定

### config/default.yaml

```yaml
# 動作モード
mode: batch

# スケジュール（cron式）
schedule:
  cron: "0 7 * * *"  # 毎日朝7時
  timezone: "Asia/Tokyo"

# 記事収集設定
collectors:
  rss:
    enabled: true
    feeds:
      - name: "Zenn"
        url: "https://zenn.dev/feed"
  hatena:
    enabled: true
    categories: ["テクノロジー"]
    minBookmarks: 50
  hackernews:
    enabled: true
    minPoints: 100

# LLM設定
llm:
  provider: "gemini"
  model: "gemini-2.0-flash"

# TTS設定
tts:
  provider: "gemini"
  model: "gemini-2.5-flash-preview-tts"
  voices: ["Laomedeia"]
```

### data/profile.yaml

ユーザーの興味プロファイルを設定:

```yaml
interests:
  - "iOS/Swift開発"
  - "TypeScript/JavaScript"

excludeTopics:
  - "ギャンブル"

excludeKeywords:
  - "PR"
  - "広告"

maxArticlesPerRun: 5

scriptStyle:
  tone: "casual"
  includeIntro: true
  includeOutro: true
```

## エンドポイント

| エンドポイント | 説明 |
|---------------|------|
| `/health` | ヘルスチェック |
| `/feed.xml` | RSSフィード（Podcast） |
| `/audio/*.mp3` | 音声ファイル |

## ライセンス

MIT
