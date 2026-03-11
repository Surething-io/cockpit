#!/bin/bash
set -e

echo "Installing Cockpit..."

# 获取最新 release 的 tgz 下载地址
URL=$(curl -fsSL https://api.github.com/repos/Surething-io/cockpit/releases/latest \
  | grep '"browser_download_url".*\.tgz"' \
  | head -1 \
  | sed 's/.*"browser_download_url": *"//;s/"//')

if [ -z "$URL" ]; then
  echo "Error: No release found" >&2
  exit 1
fi

TAG=$(echo "$URL" | grep -o 'v[0-9.]*')
echo "Latest: $TAG"

# 下载到临时文件
TMP=$(mktemp /tmp/cockpit-XXXXXX.tgz)
curl -fsSL -o "$TMP" "$URL"

# 安装
echo "Installing..."
npm install -g "$TMP"
rm -f "$TMP"

echo ""
echo "Done! Run 'cock' to start, 'cock -h' for help."
