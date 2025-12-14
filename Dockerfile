# ビルドステージ
FROM node:20-slim AS builder

WORKDIR /app

# パッケージファイルをコピー
COPY package*.json ./
COPY tsconfig.json ./

# 依存関係をインストール
RUN npm ci

# ソースコードをコピー
COPY src ./src

# TypeScriptをビルド
RUN npm run build

# 本番ステージ
FROM node:20-slim

WORKDIR /app

# ffmpegをインストール
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# パッケージファイルをコピー
COPY package*.json ./

# 本番依存関係のみインストール
RUN npm ci --only=production

# ビルド成果物をコピー
COPY --from=builder /app/dist ./dist

# 設定ファイルをコピー
COPY config ./config

# 静的アセット（画像等）をコピー
COPY public ./public

# データディレクトリを作成
RUN mkdir -p data output/scripts output/audio

# テンプレートファイルをコピー（ボリュームマウント時も参照できるよう別ディレクトリに配置）
RUN mkdir -p templates
COPY data/profile.example.yaml ./templates/

# エントリーポイントスクリプトをコピー
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 環境変数のデフォルト値
ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Asia/Tokyo

# ポートを公開
EXPOSE 3000

# ヘルスチェック
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# 実行
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
