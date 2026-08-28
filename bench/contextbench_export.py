#!/usr/bin/env python3
"""bench/contextbench_export.py — convert ContextBench's parquet to jsonl.

Reads the Lite-500 (contextbench_verified.parquet) from a ContextBench checkout and
emits one harness-friendly record per task to bench/datasets/contextbench/lite500.jsonl:
  { instance_id, repo, repo_url, base_commit, language, problem_statement,
    gold_files[], gold_spans[], gold_tok }

Usage: python bench/contextbench_export.py /path/to/ContextBench
Requires: pyarrow (pip install pyarrow). Dataset: github.com/EuniAI/ContextBench.
"""
import json
import os
import sys

import pyarrow.parquet as pq

cb = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ContextBench"
src = os.path.join(cb, "data", "contextbench_verified.parquet")
out_dir = os.path.join(os.path.dirname(__file__), "datasets", "contextbench")
os.makedirs(out_dir, exist_ok=True)
out = os.path.join(out_dir, "lite500.jsonl")

rows = pq.read_table(src).to_pylist()
n = 0
with open(out, "w") as f:
    for r in rows:
        gc = json.loads(r["gold_context"]) if isinstance(r["gold_context"], str) else r["gold_context"]
        gold_files = sorted({g["file"] for g in gc})
        gold_chars = sum(len(g.get("content", "")) for g in gc)
        f.write(json.dumps({
            "instance_id": r["instance_id"], "repo": r["repo"], "repo_url": r["repo_url"],
            "base_commit": r["base_commit"], "language": r["language"],
            "problem_statement": r["problem_statement"], "gold_files": gold_files,
            "gold_spans": gc, "gold_tok": round(gold_chars / 3.5),
        }) + "\n")
        n += 1
print(f"wrote {n} tasks -> {out}")
