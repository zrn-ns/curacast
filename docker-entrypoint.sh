#!/bin/sh
set -e

# profile.yamlが存在しない場合、テンプレートからコピー
if [ ! -f /app/data/profile.yaml ]; then
  echo "profile.yaml not found, creating from template..."
  cp /app/templates/profile.example.yaml /app/data/profile.yaml
fi

# メインプロセスを実行
exec "$@"
