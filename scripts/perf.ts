// v0.1 acceptance: `cairn map` on a 10,000-file repo, under 5 s cold and
// under 1 s warm, each judged on the median of 3 samples. Runs the built CLI (pnpm build first) as a separate
// process, so Node startup is included. The gate uses --depth 99, which
// parses every file; the default depth is reported for reference.
//
//   pnpm perf            # 10,000 files, fails if a target is missed
//   pnpm perf -- 2000    # other sizes, for quick local checks
//   CAIRN_PERF_REPORT_ONLY=1 pnpm perf   # print results, never fail (CI macOS)
//
// For profiling: CAIRN_PERF_PROFILE=<dir> writes a V8 CPU profile per run
// and thread; CAIRN_PERF_KEEP=<dir> builds the fixture there and keeps it;
// CAIRN_PERF_FIXTURE_ONLY=1 only builds the fixture (and keeps it).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = Number(process.argv[2] ?? 10_000);
const COLD_LIMIT_MS = 5_000;
const WARM_LIMIT_MS = 1_000;
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/cairn");

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "perf",
  GIT_AUTHOR_EMAIL: "perf@example.invalid",
  GIT_COMMITTER_NAME: "perf",
  GIT_COMMITTER_EMAIL: "perf@example.invalid",
};

// Deterministic content of realistic size (~60-120 lines per source file).
function tsFile(i: number): string {
  const fns = Array.from({ length: 6 + (i % 5) }, (_, k) => `
/** Handles case ${k} for item ${i}. */
export async function handle${k}_${i}(input: Input${i}, opts: Options = {}): Promise<Result<${k}>> {
  const value = await load(input.id, { retries: opts.retries ?? 3 });
  if (!value) throw new NotFoundError(\`missing \${input.id}\`);
  return { ok: true, value: transform(value, ${k}) };
}`).join("\n");
  return `import { load, transform } from "../lib/core${i % 40}";
import type { Options, Result } from "../types";

export interface Input${i} { id: string; tags: string[]; createdAt: Date }

export class Service${i} {
  private cache = new Map<string, unknown>();
  constructor(private readonly name: string) {}
  get size(): number { return this.cache.size; }
  clear(): void { this.cache.clear(); }
}
${fns}
`;
}

function pyFile(i: number): string {
  const defs = Array.from({ length: 6 }, (_, k) => `
def process_${k}_${i}(items: list[str], *, limit: int = 10) -> dict[str, int]:
    """Count items for case ${k}."""
    out: dict[str, int] = {}
    for item in items[:limit]:
        out[item] = out.get(item, 0) + ${k}
    return out
`).join("\n");
  return `from .base import Base\nimport json\n\nMAX_ITEMS = ${i}\n\nclass Worker${i}(Base):\n    def run(self) -> None:\n        pass\n${defs}`;
}

function dartFile(i: number): string {
  return `import 'package:app/core.dart';\n\nconst kLimit${i} = ${i};\n\nclass Widget${i} extends Base {\n  final String title;\n  Widget${i}(this.title);\n  int count() => title.length;\n  void reset() {}\n}\n\nint helper${i}(int a, [int b = 0]) => a + b;\n`.repeat(2);
}

function swiftFile(i: number): string {
  return `import Foundation\n\npublic struct Model${i}: Codable {\n    public var id: String\n    public var count: Int\n    public func doubled() -> Int { count * 2 }\n}\n\npublic final class Store${i} {\n    private var items: [Model${i}] = []\n    public init() {}\n    public func add(_ m: Model${i}) { items.append(m) }\n}\n`.repeat(2);
}

function generate(dir: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const area = `pkg${i % 10}/module${i % 50}/part${i % 7}`;
    const r = i % 10;
    const [path, content] =
      r < 6 ? [`${area}/file${i}.ts`, tsFile(i)]
      : r === 6 ? [`${area}/file${i}.py`, pyFile(i)]
      : r === 7 ? [`${area}/file${i}.dart`, dartFile(i)]
      : r === 8 ? [`${area}/File${i}.swift`, swiftFile(i)]
      : [`${area}/notes${i}.md`, `# Notes ${i}\n\nSome prose about module ${i % 50}.\n`];
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** Set CAIRN_PERF_PROFILE=<dir> to write a V8 CPU profile per run. */
const profileDir = process.env.CAIRN_PERF_PROFILE;

interface Run {
  ms: number;
  stats: Record<string, number>;
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

function run(cwd: string, args: string[]): Run {
  const nodeArgs = profileDir ? ["--cpu-prof", `--cpu-prof-dir=${profileDir}`] : [];
  const t0 = performance.now();
  const res = spawnSync(process.execPath, [...nodeArgs, CLI, "--json", ...args], { cwd, env, encoding: "utf8", maxBuffer: 1 << 30 });
  const ms = Math.round(performance.now() - t0);
  if (res.status !== 0) throw new Error(`cairn ${args.join(" ")} failed (${res.status}):\n${res.stderr}`);
  return { ms, stats: (JSON.parse(res.stdout) as { stats: Record<string, number> }).stats };
}

const dir = mkdtempSync(join(tmpdir(), "cairn-perf-"));
try {
  const g0 = performance.now();
  generate(dir, FILES);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, env, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  run(dir, ["init"]);
  console.log(`fixture: ${FILES} files in ${Math.round(performance.now() - g0)} ms (${dir})`);
  if (process.env.CAIRN_PERF_FIXTURE_ONLY) process.exit(0);

  // Each gated measurement runs SAMPLES times and is judged on the median:
  // GitHub runners vary over 60% in speed between and within jobs, and one
  // slow sample shouldn't decide a gate (decided 2026-11-27).
  const SAMPLES = 3;
  const deep = ["map", "--depth", "99"];
  const coldRuns: Run[] = [];
  const warmRuns: Run[] = [];
  const editRuns: Run[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    // Cold: no cache and no scratch index, so the snapshot rehashes every file.
    rmSync(join(dir, ".cairn", "cache"), { recursive: true, force: true });
    rmSync(join(dir, ".cairn", "tmp-index"), { force: true });
    coldRuns.push(run(dir, deep));
  }
  for (let i = 0; i < SAMPLES; i++) warmRuns.push(run(dir, deep));
  for (let i = 0; i < SAMPLES; i++) {
    // An edit, as in normal use: the edited folder and its parents are re-parsed.
    writeFileSync(join(dir, "pkg0/module0/part0/file0.ts"), tsFile(0) + `\nexport const edited${i} = true;\n`);
    editRuns.push(run(dir, deep));
  }
  const dflt = run(dir, ["map"]);

  const rows = [
    ["cold, --depth 99", coldRuns, COLD_LIMIT_MS],
    ["warm, --depth 99", warmRuns, WARM_LIMIT_MS],
    ["after one edit", editRuns, WARM_LIMIT_MS],
    ["warm, default depth", [dflt], null],
  ] as const;
  let failed = false;
  for (const [label, runs, limit] of rows) {
    const med = median(runs.map((r) => r.ms));
    const ok = limit === null || med < limit;
    failed ||= !ok;
    const last = runs[runs.length - 1] as Run;
    const samples = runs.length > 1 ? `  [${runs.map((r) => r.ms).join(", ")}]` : "";
    const target = limit === null ? "" : ` (median, target < ${limit} ms) ${ok ? "PASS" : "FAIL"}`;
    console.log(`${label.padEnd(20)} ${String(med).padStart(6)} ms${target}${samples}  parsed ${last.stats.parsed}, cached ${last.stats.cached}`);
  }
  if (FILES !== 10_000) console.log("(targets apply to 10,000 files; this run is informational)");
  else if (process.env.CAIRN_PERF_REPORT_ONLY) console.log(`report only: ${failed ? "some targets missed" : "all targets met"}`);
  else if (failed) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
