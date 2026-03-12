#!/bin/bash
# ============================================================
# Phase Q1 リアルタイム監視スクリプト
# bulk audio 実行中に10秒おきに進捗を確認
# ============================================================
#
# 使い方:
#   cd /home/user/webapp && bash scripts/watch-bulk-audio.sh <project_id>
#
# Ctrl+C で停止
# ============================================================

set -euo pipefail

PROJECT_ID="${1:-}"
if [ -z "$PROJECT_ID" ]; then
  echo "Usage: bash scripts/watch-bulk-audio.sh <project_id>"
  exit 1
fi

export CLOUDFLARE_API_KEY="bd57f5357e451c184954fbc51c4e501e9f2f0"
export CLOUDFLARE_EMAIL="info@rilarc.co.jp"
export CLOUDFLARE_ACCOUNT_ID="046cb89d4f61c2f9d2527b34d285de24"

d1_json() {
  npx wrangler d1 execute webapp-production --remote --command="$1" 2>/dev/null | \
    python3 -c "
import json, sys
text = sys.stdin.read()
start = text.find('[')
if start >= 0:
    data = json.loads(text[start:])
    print(json.dumps(data[0].get('results', []), ensure_ascii=False))
else:
    print('[]')
" 2>/dev/null
}

echo "🔄 Watching bulk audio progress for Project $PROJECT_ID"
echo "   Press Ctrl+C to stop"
echo ""

ITER=0
while true; do
  ITER=$((ITER + 1))
  NOW=$(date '+%H:%M:%S')
  
  JOB_JSON=$(d1_json "SELECT id, status, total_utterances, processed_utterances, success_count, failed_count FROM project_audio_jobs WHERE project_id = $PROJECT_ID ORDER BY id DESC LIMIT 1")
  
  # Parse with python
  python3 -c "
import json, sys

now = '$NOW'
iteration = $ITER
jobs = json.loads('''$JOB_JSON''')

if not jobs:
    print(f'[{now}] #{iteration} No active job found for project $PROJECT_ID')
    sys.exit(0)

j = jobs[0]
total = j.get('total_utterances', 0)
processed = j.get('processed_utterances', 0)
success = j.get('success_count', 0)
failed = j.get('failed_count', 0)
status = j.get('status', '?')
job_id = j.get('id', '?')

pct = (processed / total * 100) if total > 0 else 0

bar_len = 30
filled = int(bar_len * pct / 100)
bar = '█' * filled + '░' * (bar_len - filled)

status_emoji = {'queued': '⏳', 'running': '🔄', 'completed': '✅', 'failed': '❌'}.get(status, '❓')

print(f'[{now}] #{iteration} Job {job_id} {status_emoji} {status}')
print(f'         [{bar}] {pct:.0f}% ({processed}/{total})')
print(f'         success={success} failed={failed}')

if status in ('completed', 'failed'):
    print()
    if status == 'completed' and failed == 0:
        print('🎉 PASS: bulk audio completed with 0 failures')
    elif status == 'completed' and failed > 0:
        print(f'⚠️  PARTIAL: completed but {failed} utterances failed')
    elif status == 'failed':
        print(f'❌ FAIL: job failed ({failed}/{total} utterances failed)')
    print()
    print('Run full verification:')
    print(f'  bash scripts/verify-bulk-audio.sh $PROJECT_ID')
    sys.exit(42)  # signal to stop watching
" 2>/dev/null
  
  RESULT=$?
  if [ "$RESULT" -eq 42 ]; then
    break
  fi
  
  echo ""
  sleep 10
done
