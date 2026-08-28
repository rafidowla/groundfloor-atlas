/**
 * bench/contextbench.mjs — load ContextBench tasks into the harness format.
 *
 * ContextBench (arXiv 2602.05892): 1,136 issue-resolution tasks across 66 repos /
 * 8 languages, each with HUMAN-ANNOTATED GOLD CONTEXTS — the credible public anchor
 * for "tokens-per-task at equal-or-better quality" (it scores context recall/
 * precision/efficiency along the trajectory, not just final success).
 *
 * This adapter is dataset-agnostic about exact field names (the dataset is new;
 * confirm the schema), mapping each record to:
 *   { id, repo, type:'contextbench', question, goldFiles[], goldSymbols[], expect[] }
 * The runner then assembles each approach's context for that repo and compares
 * token cost + recall against goldFiles/goldSymbols.
 *
 * DATASET: https://github.com/EuniAI/ContextBench (leaderboard: contextbench.github.io).
 * 1,136 tasks + a Lite-500 subset; 522k lines of gold context across 66 repos.
 * NOTE: a full run also needs the 66 TARGET repos checked out (so raw/aider/atlas can
 * read their files) — start with Lite-500 + a few repos. Not vendored here.
 * Place the jsonl at bench/datasets/contextbench/*.jsonl (or set CONTEXTBENCH_PATH):
 *   CONTEXTBENCH_PATH=... node bench/contextbench.mjs --limit=20 > bench/contextbench.tasks.json
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.CONTEXTBENCH_PATH || path.join(process.cwd(), 'bench', 'datasets', 'contextbench');
const limit = Number((process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1]) || 0);

function findJsonl(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.json')).map((f) => path.join(dir, f));
}

const files = findJsonl(DIR);
if (files.length === 0) {
    process.stderr.write(
        `ContextBench dataset not found at ${DIR}.\n` +
        `Download it (see arXiv:2602.05892 for the repo/HF link), drop the jsonl files there\n` +
        `(or set CONTEXTBENCH_PATH), then re-run. This adapter then converts records to the\n` +
        `harness task format. Until then the local Atlas-repo task set (bench/tasks.json) runs.\n`,
    );
    process.exit(3);
}

// Map a raw ContextBench record → harness task. Field names are guarded with
// several common aliases since the dataset schema should be confirmed.
function toTask(rec, i) {
    const gold = rec.gold_context || rec.gold_files || rec.context || rec.relevant_files || [];
    const goldFiles = (Array.isArray(gold) ? gold : Object.keys(gold || {})).filter((x) => typeof x === 'string');
    return {
        id: rec.instance_id || rec.id || rec.task_id || `cb-${i}`,
        repo: rec.repo || rec.repository || null,
        type: 'contextbench',
        question: rec.problem_statement || rec.question || rec.issue || rec.query || '',
        goldFiles,
        goldSymbols: rec.gold_symbols || rec.symbols || [],
        expect: goldFiles.map((f) => path.basename(f).replace(/\.[a-z]+$/, '')),
    };
}

const out = [];
for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
        try { out.push(toTask(JSON.parse(lines[i]), out.length)); } catch { /* skip bad line */ }
        if (limit && out.length >= limit) break;
    }
    if (limit && out.length >= limit) break;
}
process.stdout.write(JSON.stringify(out, null, 2));
process.stderr.write(`\nconverted ${out.length} ContextBench tasks${limit ? ` (limit ${limit})` : ''}.\n`);
