#!/usr/bin/env python3
"""bench/aider_map.py — emit Aider's repo-map (the graph-vs-graph competitor).

Aider builds a tree-sitter + PageRank ranking over the repo's symbol/dependency
graph and renders a token-budgeted "map" it feeds the LLM instead of whole files.
This script reproduces that exact artifact so the benchmark can token-count it
head-to-head against Atlas.

Usage: python aider_map.py <repo> <map_tokens> [focus_file ...]
Stdout = the repo map (empty on failure). Requires `aider-chat` installed.
"""
import os
import sys


def main() -> int:
    repo = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    budget = int(sys.argv[2]) if len(sys.argv) > 2 else 2048
    focus = sys.argv[3:]

    try:
        from aider.repomap import RepoMap
        from aider.io import InputOutput
        from aider.models import Model
    except Exception as e:  # aider not installed / incompatible
        sys.stderr.write(f"aider import failed: {e}\n")
        return 2

    # All TS source files as the candidate set (mirror Atlas's index scope).
    others = []
    for root, dirs, files in os.walk(os.path.join(repo, "src")):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "dist", ".git")]
        for f in files:
            if f.endswith((".ts", ".tsx")) and not f.endswith(".d.ts"):
                others.append(os.path.join(root, f))

    io = InputOutput()
    model = Model("gpt-4o")  # used only for its tokenizer / token budgeting
    rm = RepoMap(map_tokens=budget, root=repo, main_model=model, io=io, verbose=False)

    chat_files = [os.path.join(repo, f) for f in focus if os.path.exists(os.path.join(repo, f))]
    other_files = [f for f in others if f not in chat_files]
    try:
        mp = rm.get_repo_map(chat_files, other_files)
    except Exception as e:
        sys.stderr.write(f"get_repo_map failed: {e}\n")
        return 3
    sys.stdout.write(mp or "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
