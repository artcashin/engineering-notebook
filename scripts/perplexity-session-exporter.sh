#!/usr/bin/env bash
#
# perplexity-session-exporter.sh
#
# Runs inside a Perplexity Computer session. Lists all user sessions,
# downloads each transcript, converts to engineering-notebook JSONL format,
# and pushes to a GitHub repo for local sync.
#
# MUST be run via the bash tool with api_credentials=["pplx-sdk"]
#
# Usage:
#   bash perplexity-session-exporter.sh [--limit N] [--repo URL] [--output-dir PATH] [--force]
#
# IMPORTANT: pplx CLI commands use file redirects (>) not command substitution ($())
#   because the bash tool's pplx-sdk credential injection doesn't propagate to
#   command substitution subshells.
#

set -uo pipefail

LIMIT=100
REPO="https://github.com/artcashin/perplexity-sessions.git"
OUTPUT_DIR="/home/user/workspace/perplexity-sessions"
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit)       LIMIT="$2"; shift 2 ;;
    --repo)        REPO="$2"; shift 2 ;;
    --output-dir)  OUTPUT_DIR="$2"; shift 2 ;;
    --force)       FORCE=true; shift ;;
    *) shift ;;
  esac
done

mkdir -p "$OUTPUT_DIR"
WORK_TMP=$(mktemp -d)
trap 'rm -rf "$WORK_TMP"' EXIT

echo "=== Perplexity Session Exporter ==="
echo "Output dir: $OUTPUT_DIR"
echo "Limit: $LIMIT"
echo ""

# Step 1: List all sessions (file redirect, NOT command substitution)
echo "Listing sessions..."
pplx session list --limit "$LIMIT" > "$WORK_TMP/sessions.json" 2>/dev/null

SESSION_COUNT=$(python3 -c "import json; data=json.load(open('$WORK_TMP/sessions.json')); print(len(data))" 2>/dev/null || echo "0")
echo "Found $SESSION_COUNT session(s)"

if [[ "$SESSION_COUNT" == "0" ]]; then
  echo "No sessions found. Exiting."
  exit 0
fi

# Extract session UUIDs and types to a file
python3 -c "
import json
with open('$WORK_TMP/sessions.json') as f:
    data = json.load(f)
for s in data:
    print(f\"{s['context_uuid']}|{s.get('type', 'search')}\")
" > "$WORK_TMP/session_list.txt"

# Step 2: Download and convert each session
PROCESSED=0
SKIPPED=0
ERRORS=0

while IFS='|' read -r SESSION_UUID SESSION_TYPE; do
  OUTPUT_FILE="$OUTPUT_DIR/${SESSION_UUID}.jsonl"

  if [[ "$FORCE" == false && -f "$OUTPUT_FILE" ]]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo -n "  $SESSION_UUID... "

  DL_DIR="$WORK_TMP/dl-$SESSION_UUID"
  mkdir -p "$DL_DIR"

  # Download content - metadata JSON to stdout (file redirect), conversation.jsonl to disk
  pplx session get "$SESSION_UUID" --download-content --download-path "$DL_DIR" > "$DL_DIR/meta.json" 2>/dev/null
  DL_EXIT=$?

  if [[ $DL_EXIT -ne 0 ]]; then
    echo "FAILED (download)"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  CONVO_FILE="$DL_DIR/conversation.jsonl"

  if [[ ! -f "$CONVO_FILE" ]]; then
    echo "NO CONVERSATION"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Convert to engineering-notebook JSONL format
  python3 - "$DL_DIR/meta.json" "$CONVO_FILE" "$OUTPUT_FILE" "$SESSION_TYPE" << 'PYEOF'
import json
import sys
import os

meta_file, convo_file, output_file, session_type = sys.argv[1:5]

try:
    with open(meta_file) as f:
        meta = json.load(f)
except Exception:
    meta = {}

meta_record = {
    "type": "perplexity_meta",
    "session_id": meta.get("session_id", os.path.basename(output_file).replace(".jsonl", "")),
    "title": meta.get("title", "untitled"),
    "status": meta.get("status", "completed"),
    "created_at": meta.get("created_at", ""),
    "updated_at": meta.get("updated_at", ""),
    "author_username": meta.get("author_username", ""),
    "project_id": meta.get("project_id"),
    "url": meta.get("url", ""),
    "source": session_type,
}

turn_count = 0
with open(output_file, "w") as f:
    f.write(json.dumps(meta_record) + "\n")
    with open(convo_file) as cf:
        for line in cf:
            line = line.strip()
            if not line:
                continue
            try:
                turn = json.loads(line)
            except Exception:
                continue
            f.write(json.dumps({
                "type": "perplexity_turn",
                "turn": turn.get("turn", 0),
                "query": turn.get("query", ""),
                "answer": turn.get("answer", ""),
                "timestamp": meta.get("created_at", ""),
            }) + "\n")
            turn_count += 1

print(f"OK ({turn_count} turns)")
PYEOF

  PROCESSED=$((PROCESSED + 1))

done < "$WORK_TMP/session_list.txt"

echo ""
echo "=== Export Complete ==="
echo "Processed: $PROCESSED"
echo "Skipped (already exist): $SKIPPED"
echo "Errors: $ERRORS"

# Step 3: Push to GitHub repo
if [[ -n "$REPO" && "$PROCESSED" -gt 0 ]]; then
  echo ""
  echo "Pushing to GitHub: $REPO"

  cd "$OUTPUT_DIR"

  if [[ ! -d ".git" ]]; then
    git init
    git config user.email "artinnj@gmail.com"
    git config user.name "artcashin"
    git remote add origin "$REPO"
  fi

  git add -A
  git commit -m "Export $(date -u +%Y-%m-%dT%H:%M:%SZ) - $PROCESSED new, $SKIPPED skipped" || echo "Nothing to commit"
  git push -u origin main 2>/dev/null || git push -u origin master 2>/dev/null || echo "Push failed"

  echo "Done."
fi
