#!/bin/bash
# =============================================================================
# SSOT: ローカルD1データベース リセット＆初期化スクリプト
# =============================================================================
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

cd "$(dirname "$0")/.."

echo -e "${BLUE}=== SSOT: Local D1 Reset ===${NC}"

# Step 1: Delete local D1
echo -e "${YELLOW}[1/4]${NC} Deleting local D1..."
rm -rf .wrangler/state/v3/d1
echo -e "${GREEN}✓${NC} Done"

# Step 2: Apply full schema
echo -e "${YELLOW}[2/4]${NC} Applying full schema..."
npx wrangler d1 execute webapp-production --local --file=migrations/0001_full_schema_from_production.sql >/dev/null 2>&1
echo -e "${GREEN}✓${NC} Done"

# Step 3: Apply incremental migrations (0023+)
# 0001_full_schema_from_production.sql は本番スキーマ（~0022相当）
# 0023以降は増分として適用（text_render_mode等の重要なカラム追加含む）
echo -e "${YELLOW}[3/4]${NC} Applying new migrations (0023+)..."
for f in migrations/002[3-9]*.sql migrations/003*.sql migrations/004*.sql; do
  if [ -f "$f" ]; then
    npx wrangler d1 execute webapp-production --local --file="$f" >/dev/null 2>&1 && echo -e "  ${GREEN}✓${NC} $(basename $f)" || echo -e "  ${YELLOW}⚠${NC} $(basename $f) (skipped/error)"
  fi
done
echo -e "${GREEN}✓${NC} Done"

# Step 4: Verify
echo -e "${YELLOW}[4/4]${NC} Verifying..."
TABLE_COUNT=$(npx wrangler d1 execute webapp-production --local --command="SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'" 2>&1 | grep -oP '"c":\s*\K\d+' || echo "?")
echo -e "  Tables: ${TABLE_COUNT}"
echo -e "${GREEN}=== Reset Complete ===${NC}"
