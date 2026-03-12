#!/bin/bash
# ============================================================
# Phase Q1 本番検証スクリプト
# bulk audio Queue consumer 動作確認
# ============================================================
#
# 使い方:
#   1. ブラウザで bulk audio を実行してから
#   2. このスクリプトを実行:
#      cd /home/user/webapp && bash scripts/verify-bulk-audio.sh <project_id>
#
# 例:
#      bash scripts/verify-bulk-audio.sh 472
#
# ============================================================

set -euo pipefail

PROJECT_ID="${1:-}"
if [ -z "$PROJECT_ID" ]; then
  echo "Usage: bash scripts/verify-bulk-audio.sh <project_id>"
  echo "Example: bash scripts/verify-bulk-audio.sh 472"
  exit 1
fi

# Cloudflare credentials
export CLOUDFLARE_API_KEY="bd57f5357e451c184954fbc51c4e501e9f2f0"
export CLOUDFLARE_EMAIL="info@rilarc.co.jp"
export CLOUDFLARE_ACCOUNT_ID="046cb89d4f61c2f9d2527b34d285de24"
QUEUE_ID="9463480ab28d4e4fbb0db95e64fcbf39"
DLQ_ID="e341db9b39704773996d874d65c036c2"

d1() {
  npx wrangler d1 execute webapp-production --remote --command="$1" 2>/dev/null | \
    python3 -c "
import json, sys
text = sys.stdin.read()
start = text.find('[')
if start >= 0:
    data = json.loads(text[start:])
    results = data[0].get('results', [])
    if not results:
        print('  (no rows)')
    else:
        # print header
        keys = list(results[0].keys())
        print('  ' + ' | '.join(f'{k:>20s}' for k in keys))
        print('  ' + '-' * (22 * len(keys)))
        for row in results:
            print('  ' + ' | '.join(f'{str(v):>20s}' for v in row.values()))
else:
    print('  (parse error)')
" 2>/dev/null
}

echo ""
echo "============================================================"
echo " Phase Q1 検証: Project $PROJECT_ID"
echo " $(date '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================================"

# ---- 1. project_audio_jobs ----
echo ""
echo "━━━ 1. project_audio_jobs ━━━"
echo "  (status: queued → running → completed)"
d1 "SELECT id, status, total_utterances, processed_utterances, success_count, failed_count, skipped_count, last_error FROM project_audio_jobs WHERE project_id = $PROJECT_ID ORDER BY id DESC LIMIT 3"

# ---- 2. audio_generations summary ----
echo ""
echo "━━━ 2. audio_generations (status summary) ━━━"
d1 "SELECT ag.status, COUNT(*) as count FROM audio_generations ag JOIN scenes s ON ag.scene_id = s.id WHERE s.project_id = $PROJECT_ID GROUP BY ag.status"

# ---- 3. latest audio_generations ----
echo ""
echo "━━━ 3. latest audio_generations (last 5) ━━━"
d1 "SELECT ag.id, ag.scene_id, ag.status, ag.provider, ag.voice_id, SUBSTR(ag.r2_url, 1, 50) as r2_url, ag.duration_ms, ag.error_message FROM audio_generations ag JOIN scenes s ON ag.scene_id = s.id WHERE s.project_id = $PROJECT_ID ORDER BY ag.id DESC LIMIT 5"

# ---- 4. Queue status ----
echo ""
echo "━━━ 4. Queue status ━━━"
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues/$QUEUE_ID" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
  -H "X-Auth-Key: $CLOUDFLARE_API_KEY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
r = d.get('result', {})
print(f'  Queue:     {r.get(\"queue_name\", \"?\")}')
consumers = r.get('consumers', [])
print(f'  Consumers: {len(consumers)}')
for c in consumers:
    print(f'    - {c.get(\"script\",\"?\")} (batch={c.get(\"settings\",{}).get(\"batch_size\",\"?\")}, retries={c.get(\"settings\",{}).get(\"max_retries\",\"?\")})')
producers = r.get('producers', [])
print(f'  Producers: {len(producers)}')
for p in producers:
    print(f'    - {p.get(\"script\",\"?\")}')
" 2>/dev/null

# ---- 5. DLQ check ----
echo ""
echo "━━━ 5. DLQ (Dead Letter Queue) ━━━"
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues/$DLQ_ID" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
  -H "X-Auth-Key: $CLOUDFLARE_API_KEY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
r = d.get('result', {})
print(f'  DLQ:       {r.get(\"queue_name\", \"?\")}')
consumers = r.get('consumers', [])
if consumers:
    print(f'  ⚠️ DLQ has {len(consumers)} consumers (messages are being processed)')
else:
    print(f'  ✅ DLQ has no consumers (failed messages will accumulate for review)')
" 2>/dev/null

# ---- 6. Consumer Worker logs (recent errors) ----
echo ""
echo "━━━ 6. Consumer Worker status ━━━"
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/webapp-audio-consumer" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
  -H "X-Auth-Key: $CLOUDFLARE_API_KEY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d.get('success'):
    print('  ✅ Consumer Worker is deployed')
else:
    print('  ❌ Consumer Worker NOT found:', d.get('errors', []))
" 2>/dev/null

# ---- Summary ----
echo ""
echo "============================================================"
echo " 判定基準:"
echo "  ✅ project_audio_jobs: status = 'completed'"
echo "     processed_utterances = total_utterances"
echo "  ✅ audio_generations: 全件 completed (failed = 0)"
echo "  ✅ Queue: consumers ≥ 1"
echo "  ✅ DLQ: no messages (empty)"
echo "============================================================"
echo ""
