#!/usr/bin/env python3
"""
Perplexity Session Exporter

Runs inside a Perplexity Computer session. Lists all user sessions,
downloads each transcript, converts to engineering-notebook JSONL format,
and optionally pushes to a GitHub repo for local sync.

Usage:
    python3 perplexity-session-exporter.py [--limit N] [--repo URL] [--output-dir PATH] [--force]

Defaults:
    --limit       100   (max sessions to fetch)
    --repo        (none — just writes files locally if not specified)
    --output-dir  ./perplexity-sessions
    --force       re-export sessions that already exist

NOTE: This script must be run from within a Perplexity Computer session
      where the `pplx` CLI is available and authenticated. It cannot run
      on your local machine — Perplexity does not have a public session
      listing API.

      To use: run this from a Computer bash tool call, or paste it into
      a Computer session and execute it. Then sync the output directory
      to your local machine (e.g., push to a GitHub repo).
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import shutil


def run_pplx(args: list[str]) -> tuple[str, str, int]:
    """Run pplx CLI command and return (stdout, stderr, returncode)."""
    result = subprocess.run(
        ["pplx"] + args,
        capture_output=True,
        text=True,
    )
    return result.stdout, result.stderr, result.returncode


def list_sessions(limit: int) -> list[dict]:
    """List all sessions via pplx CLI."""
    stdout, stderr, rc = run_pplx(["session", "list", "--limit", str(limit)])
    if rc != 0:
        raise RuntimeError(f"pplx session list failed: {stderr.strip()}")
    return json.loads(stdout) if stdout.strip() else []


def download_session(session_uuid: str, dest_dir: str) -> dict:
    """Download a session's transcript and metadata.

    Returns the metadata dict from pplx session get --download-content.
    """
    os.makedirs(dest_dir, exist_ok=True)
    stdout, stderr, rc = run_pplx([
        "session", "get", session_uuid,
        "--download-content", "--download-path", dest_dir
    ])
    if rc != 0:
        raise RuntimeError(f"download failed: {stderr.strip()}")

    try:
        meta = json.loads(stdout) if stdout.strip() else {}
    except json.JSONDecodeError:
        meta = {}
    return meta


def convert_session(meta: dict, convo_path: str, output_path: str, session_type: str) -> int:
    """Convert a downloaded Perplexity session to engineering-notebook JSONL format.

    Writes one perplexity_meta line followed by perplexity_turn lines.
    Returns the number of turns written.
    """
    session_id = meta.get("session_id", os.path.basename(output_path).replace(".jsonl", ""))
    title = meta.get("title", "untitled")
    status = meta.get("status", "completed")
    created_at = meta.get("created_at", "")
    updated_at = meta.get("updated_at", "")
    author = meta.get("author_username", "")
    project_id = meta.get("project_id")
    url = meta.get("url", "")

    meta_record = {
        "type": "perplexity_meta",
        "session_id": session_id,
        "title": title,
        "status": status,
        "created_at": created_at,
        "updated_at": updated_at,
        "author_username": author,
        "project_id": project_id,
        "url": url,
        "source": session_type,
    }

    turn_count = 0
    with open(output_path, "w") as f:
        f.write(json.dumps(meta_record) + "\n")

        with open(convo_path, "r") as cf:
            for line in cf:
                line = line.strip()
                if not line:
                    continue
                try:
                    turn = json.loads(line)
                except json.JSONDecodeError:
                    continue

                turn_record = {
                    "type": "perplexity_turn",
                    "turn": turn.get("turn", 0),
                    "query": turn.get("query", ""),
                    "answer": turn.get("answer", ""),
                    "timestamp": created_at,
                }
                f.write(json.dumps(turn_record) + "\n")
                turn_count += 1

    return turn_count


def push_to_git(output_dir: str, repo_url: str):
    """Push exported sessions to a GitHub repo."""
    os.chdir(output_dir)

    if not os.path.exists(".git"):
        subprocess.run(["git", "init"], check=True)
        subprocess.run(["git", "remote", "add", "origin", repo_url], check=True)

    subprocess.run(["git", "add", "-A"], check=True)

    from datetime import datetime, timezone
    commit_msg = f"Export {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}"
    result = subprocess.run(["git", "commit", "-m", commit_msg], capture_output=True, text=True)
    if result.returncode != 0:
        print("Nothing to commit")
        return

    # Try main first, then master
    for branch in ["main", "master"]:
        result = subprocess.run(
            ["git", "push", "-u", "origin", branch],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            print(f"Pushed to {branch}")
            return

    print("Push failed — check repo URL and credentials")


def main():
    parser = argparse.ArgumentParser(
        description="Export Perplexity sessions to engineering-notebook format"
    )
    parser.add_argument("--limit", type=int, default=100, help="Max sessions to fetch")
    parser.add_argument("--repo", type=str, default="", help="GitHub repo URL to push to")
    parser.add_argument("--output-dir", type=str, default="./perplexity-sessions",
                        help="Output directory")
    parser.add_argument("--force", action="store_true",
                        help="Re-export sessions that already exist")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    print("=== Perplexity Session Exporter ===")
    print(f"Output dir: {args.output_dir}")
    print(f"Limit: {args.limit}")
    print()

    # Step 1: List all sessions
    print("Listing sessions...")
    try:
        sessions = list_sessions(args.limit)
    except RuntimeError as e:
        print(f"Error listing sessions: {e}")
        print("\nThis script must be run from within a Perplexity Computer session")
        print("where the `pplx` CLI is available. It cannot run on your local machine.")
        sys.exit(1)

    print(f"Found {len(sessions)} session(s)")

    if not sessions:
        print("No sessions found. Exiting.")
        sys.exit(0)

    # Step 2: Download and convert each session
    processed = 0
    skipped = 0
    errors = 0

    for session in sessions:
        session_uuid = session["context_uuid"]
        session_type = session.get("type", "search")
        output_file = os.path.join(args.output_dir, f"{session_uuid}.jsonl")

        if not args.force and os.path.exists(output_file):
            skipped += 1
            continue

        print(f"  {session_uuid}... ", end="", flush=True)

        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                # Download session content
                meta = download_session(session_uuid, tmp_dir)

                convo_file = os.path.join(tmp_dir, "conversation.jsonl")
                if not os.path.exists(convo_file):
                    print("NO CONVERSATION")
                    skipped += 1
                    continue

                # Convert to engineering-notebook format
                turn_count = convert_session(meta, convo_file, output_file, session_type)
                print(f"OK ({turn_count} turns)")
                processed += 1

        except Exception as e:
            print(f"FAILED ({e})")
            errors += 1

    print()
    print("=== Export Complete ===")
    print(f"Processed: {processed}")
    print(f"Skipped (already exist): {skipped}")
    print(f"Errors: {errors}")

    # Step 3: Push to GitHub repo if specified
    if args.repo:
        print()
        print(f"Pushing to GitHub: {args.repo}")
        try:
            push_to_git(args.output_dir, args.repo)
            print("Done. Clone or pull this repo locally and point engineering-notebook at the directory.")
        except Exception as e:
            print(f"Git push failed: {e}")


if __name__ == "__main__":
    main()
