#!/usr/bin/env bash

set -euo pipefail

if [[ -z "${FEISHU_WEBHOOK_URL:-}" || -z "${FEISHU_SECRET:-}" ]]; then
  echo "FEISHU_WEBHOOK_URL / FEISHU_SECRET environment variables are required" >&2
  exit 1
fi

AGENTS=${POSITIONS_AGENTS:-deepseek-chat-v3.1}
INTERVAL=${POSITIONS_INTERVAL:-180}

while true; do
  npm run feishu:positions -- --agents "$AGENTS"
  sleep "$INTERVAL"
done
