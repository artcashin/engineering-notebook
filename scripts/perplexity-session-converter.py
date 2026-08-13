#!/usr/bin/env python3
"""
Perplexity Session Converter

Converts downloaded Perplexity session transcripts (conversation.jsonl + metadata)
to engineering-notebook JSONL format.

This script does NOT call pplx — it only processes files that were already
downloaded. The pplx calls must be done from the bash tool directly.

Usage:
    python3 perplexity-session-converter.py <meta.json> <conversation.jsonl> <output.jsonl> <session_type>
"""

import json
import sys
import os


def convert_session(meta_file, convo_file, output_file, session_type):
    """Convert a downloaded Perplexity session to engineering-notebook JSONL format."""
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

    return turn_count


if __name__ == "__main__":
    if len(sys.argv) != 5:
        print(f"Usage: {sys.argv[0]} <meta.json> <conversation.jsonl> <output.jsonl> <session_type>")
        sys.exit(1)

    count = convert_session(*sys.argv[1:5])
    print(f"OK ({count} turns)")
