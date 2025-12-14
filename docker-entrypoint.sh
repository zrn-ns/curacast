#!/bin/sh
set -e

# profile.yamlが存在しない場合、exampleからコピー
if [ ! -f /app/data/profile.yaml ]; then
  echo "profile.yaml not found, creating from example..."
  cp /app/data/profile.example.yaml /app/data/profile.yaml
fi

# メインプロセスを実行
exec "$@"
