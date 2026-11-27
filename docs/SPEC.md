# CAIRN — Product & Engineering Spec

Nov 27, 2026 · @Emir Ucgun

CAIRN (Context And Intent Record for Next agents) is a git-native memory layer that lets any AI coding agent understand a repo in a few thousand tokens instead of re-reading it. This spec is the source of truth for building it with Claude Code.

## How to use this spec with Claude Code

Export this doc as Markdown and save it in the repo as `docs/SPEC.md`. Then put the block below in the repo's `CLAUDE.md`.

```markdown
# CAIRN — instructions for Claude Code

You are building CAIRN. docs/SPEC.md is the source of truth.

## Working rules
- Build ONE milestone at a time (SPEC §Roadmap). Do not start the next until every acceptance criterion of the current one passes.
- Before coding a milestone: write a short plan in docs/plans/<milestone>.md and wait for my OK.
- Never change the on-disk formats in SPEC §Data model without updating the spec first and bumping `schema`.
- Every command gets tests (vitest) against a temp git repo fixture. Run `pnpm test` before saying a task is done.
- Shell out to the `git` binary via the wrapper in src/git/; never parse .git internals by hand.
- Never send file contents to an LLM unless the summarizer is explicitly enabled and the file passes the ignore rules (SPEC §Security).
- Keep dependencies minimal; ask before adding one.
- If the spec is ambiguous, add the question to SPEC §Open questions and ask me; do not guess.

## Commands
- pnpm build · pnpm test · pnpm lint · pnpm cairn <args> (runs the local CLI)
```

Recommended loop per milestone:

1. Ask Claude Code to read `docs/SPEC.md` and draft the milestone plan.
2. Review and approve the plan.
3. Let it implement in small commits, one command at a time.
4. Check the acceptance criteria yourself, then tick them in the spec.

From v0.3 on, use CAIRN on its own repo (dogfooding): run `cairn context` at the start of each Claude Code session.

## Vision and problem

AI coding agents spend most of their tokens navigating, not coding: every new session re-reads files to rebuild an understanding that already existed yesterday.

**Who it's for:** solo developers and vibe coders who build with AI agents (Claude Code, OpenCode, Codex, Cursor, Gemini CLI) and often switch between them.

**What CAIRN does:**

- Gives agents a cheap, layered view of the repo: skeletons, then summaries, then source only when needed.
- Tells each agent exactly what changed since it last looked.
- Records why code is the way it is, so agents read decisions instead of reverse-engineering them.
- Belongs to the repo, not to a model: start in Claude Code, continue in OpenCode, lose nothing.

**Differentiator:** existing tools (CodeGraph, codebase-memory-mcp, AiDex, tokensave) index code from the outside and rescan it. CAIRN is built on version control, so it uses git's content hashes for staleness-free caching, per-agent session cursors, and decision history that travels with `git push`.

**One-line pitch:** the memory layer that lets every AI agent pick up your project where the last one left off.

## Principles and non-goals

Principles, in priority order when they conflict:

1. **Correct before clever.** A summary is never shown as current if its content hash doesn't match. Source is always one call away.
2. **Git-native, zero lock-in.** Works in any git repo, changes nothing about how git is used, and `rm -rf .cairn` fully uninstalls it.
3. **Agent-neutral.** Every feature works through MCP and the CLI; agent-specific adapters only add automatic capture.
4. **Useful with no AI.** Skeletons, maps and context diffs work without any LLM. Summaries are an optional upgrade.
5. **Local and private by default.** No server, no telemetry. LLM calls default to a local model.
6. **Measured.** Every feature that claims to save tokens reports how many it saved.

Non-goals (do not build these):

- Replacing git's storage, branching or merging.
- A hosted service, accounts or sync servers.
- A full project-management, CI or advertising tool. Lifecycle features only read and write memory records.
- Running or editing code on the agent's behalf.

## Architecture overview

CAIRN is one TypeScript package with a shared core, two front doors (CLI and MCP server), and optional adapters and dashboard. Git stays untouched; CAIRN reads git objects and writes only to `.cairn/` and one notes ref.

&#91;embedded content: CAIRN architecture · 4 layers\]

Agents reach CAIRN through the CLI, the MCP server or adapters; all three call the same core, which reads git objects and writes only to `.cairn/` and `refs/notes/cairn`. The dashed box is optional.

### Three layers of understanding

| Layer | Made by | Cost | Invalidated by |
| --- | --- | --- | --- |
| Skeleton (symbols, signatures, imports) | tree-sitter, no AI | free, milliseconds | blob hash change |
| Summary (file and folder, 1–3 sentences) | pluggable LLM, lazily | one call per new content | blob/tree hash or generator version change |
| Source (exact lines) | the working tree | full tokens | never cached |

### On-disk layout

```
repo/
├── .git/
│   └── refs/notes/cairn          # why-notes + lifecycle records (pushed with the repo)
├── .cairn/                       # gitignored, safe to delete
│   ├── config.toml
│   ├── cache/<2 hex>/<62 hex>.json   # skeleton + summary entries
│   ├── sessions/<agent-id>.json      # session cursors
│   ├── tmp-index                     # scratch index for snapshots
│   └── stats.jsonl                   # token accounting log
└── .cairnignore                  # extra exclusions (gitignore syntax)
```

### Source layout

```
src/
├── core/        # snapshot, cache, skeleton, summarize, context, pack, records
├── git/         # thin typed wrapper over the git binary
├── cli/         # commander commands, one file per command
├── mcp/         # MCP server exposing core as tools
├── adapters/    # claude-code, opencode, codex, cursor, gemini, generic
├── summarizers/ # ollama, anthropic, openai-compatible
└── ui/          # dashboard (v0.5), separate build
```

### Tech stack

| Concern | Choice | Why |
| --- | --- | --- |
| Language / runtime | TypeScript, Node 22+, ESM | Same language for CLI, MCP and UI |
| Package manager | pnpm | Fast, strict |
| CLI | commander | Small, standard |
| Parsing | web-tree-sitter (WASM grammars) | No native builds; TS, JS, Python, Swift, Dart, Go first |
| Git access | `git` binary via `execa` | Fast, correct, respects user config |
| MCP | `@modelcontextprotocol/sdk` (stdio) | Works with every target agent |
| Token counting | `js-tiktoken` estimate, per-model factor | Good enough for budgets |
| Storage | JSON files (v0.1–v0.4), SQLite optional later | Debuggable, no deps |
| Tests | vitest + temp-repo fixtures | Fast |
| Dashboard | Vite + React, served by `cairn ui` | Lightweight, local |

## Data model

All formats are versioned JSON with a top-level `"schema"` integer. Readers must reject a higher schema than they know and migrate lower ones. Define every type once in `src/core/types.ts` with zod schemas and derive TS types from them.

### Cache key

```
cache_key = sha256( object_kind + ":" + git_object_hash + ":" + layer + ":" + generator_id )
```

- `object_kind`: `blob` (file) or `tree` (folder).
- `git_object_hash`: the hash git itself assigns (`git rev-parse <rev>:<path>`, or from a snapshot tree).
- `layer`: `skeleton` or `summary`.
- `generator_id`: for skeletons `ts:<lang>@<grammar-pkg-version>+x<extractor-version>` (e.g. `ts:typescript@0.1.13+x1`), so a grammar or extraction-query change, or the same bytes parsed as a different language, gets a new key; for summaries `<provider>/<model>@p<prompt-version>`.
- Stored at `.cairn/cache/<key[0:2]>/<key[2:]>.json`. Same content at two paths shares one entry.

### Cache entry

```json
{
  "schema": 1,
  "key": "5e1b…",
  "object": { "kind": "blob", "hash": "9f2c4e…" },
  "layer": "summary",
  "path_hint": "src/auth/session.ts",
  "lang": "typescript",
  "skeleton": [
    { "sym": "login", "kind": "function", "sig": "(email: string, pw: string) => Promise<Session>", "lines": [12, 48], "exported": true }
  ],
  "imports": ["../lib/supabase"],
  "summary": "Creates and refreshes user sessions via Supabase auth. Throws AuthError on invalid credentials.",
  "children": null,
  "tokens": { "source": 4210, "skeleton": 180, "summary": 45 },
  "generator": "ollama/qwen2.5-coder:7b@p3",
  "created": "2026-11-27T08:20:00Z"
}
```

`imports` holds raw import specifiers exactly as written in the source. Entries are keyed by content, not path, so resolving specifiers to repo paths happens when a command reads the entry, using the path it is being read for. `tokens.source` is a fast `chars / 4` estimate; `tokens.skeleton` and `tokens.summary`, and every count of text CAIRN serves, use `js-tiktoken`.

Fields that don't apply to an entry are `null`, never omitted. A `skeleton`-layer entry has `summary: null` and `tokens.summary: null`; a `summary`-layer entry carries the skeleton it was built from. For `tree` entries, `tokens.source` is the sum over its children.

For `tree` entries, `skeleton` is null and `children` lists `{ "name", "kind", "hash" }` for each child, so a folder summary can be traced to exactly the child content it was built from.

### Session cursor

`.cairn/sessions/<agent-id>.json`, one per agent identity (`claude-code`, `opencode`, `codex`, `cursor`, `gemini`, or a user-chosen id).

```json
{
  "schema": 1,
  "agent": "claude-code",
  "last_snapshot_tree": "7a1f9b…",
  "last_head": "c03e11…",
  "last_seen": "2026-11-27T07:55:00Z",
  "active_task": "rec_01JDX…"
}
```

`last_head` is `null` in a repo with no commits, and `active_task` is `null` when no task is active. The agent id becomes a file name, so it must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.

### Records (why-notes and lifecycle)

Every piece of project memory is a record. Records are stored as JSON lines in git notes under `refs/notes/cairn`, attached to the commit they belong to; records with no commit yet (a plan, an in-progress session) are attached to `HEAD` and re-attached on the next commit.

```json
{
  "schema": 1,
  "id": "rec_01JDXK3V…",
  "type": "decision",
  "title": "Refresh tokens proactively",
  "body": "Refresh 60s before expiry instead of on 401.",
  "intent": "Fix login loop when refresh token expires",
  "prompt": "users get logged out every 5 minutes, fix it",
  "rejected": ["Longer token TTL – security concern"],
  "links": { "commits": ["9f2c…"], "paths": ["src/auth/"], "records": ["rec_01JDX…"] },
  "author": { "kind": "agent", "id": "claude-code", "model": "claude-opus-5-5" },
  "human_approved": true,
  "created": "2026-11-27T08:30:00Z"
}
```

| `type` | Written by | Purpose |
| --- | --- | --- |
| `decision` | agent or human, `cairn note` | Why something is the way it is |
| `session` | adapters, `cairn handoff` | What an agent did, what's unfinished |
| `plan` | `cairn plan add` | A goal or spec; agents see why a feature exists |
| `task` | `cairn plan task` | A unit of work linked to a plan |
| `release` | `cairn release` | Version, date, linked decisions |
| `asset` | `cairn promote` | Launch post, store text, tweet drafted from a release |

IDs are ULIDs, so they sort by time. Notes merge with `git notes merge -s cat_sort_uniq` so two machines never conflict.

## Core algorithms

Four algorithms carry the product; each must be deterministic given the same repo state and config.

### 1. Snapshot the working tree

Goal: a tree hash for the current state, including uncommitted and untracked (non-ignored) files, without touching the user's index.

```bash
GIT_INDEX_FILE=.cairn/tmp-index git read-tree HEAD   # or --empty on a repo with no commits
GIT_INDEX_FILE=.cairn/tmp-index git add -A
GIT_INDEX_FILE=.cairn/tmp-index git write-tree       # → snapshot tree hash
```

- Then apply `.cairnignore` by removing matching paths from the tmp index before `write-tree`.
- Must never modify `.git/index`, `HEAD`, or any ref other than `refs/notes/cairn`.
- Target: under 300 ms on a 10,000-file repo after the first run (git's stat cache does the work).

### 2. Build skeletons and summaries bottom-up

1. Walk the snapshot tree (`git ls-tree -r -t`), collecting `(path, kind, hash)`.
2. For each blob of a supported language: if no skeleton entry exists for its key, parse with tree-sitter and write one.
3. Summaries are lazy: computed only when a command needs them for a path.
4. A file summary is made from its skeleton plus the first N lines of source (config, default 200).
5. A folder summary is made only from its children's summaries and skeleton names, never from raw source.
6. Recursion is memoized by key, so an unchanged subtree costs one cache lookup.

Cost of one edited file at depth d: 1 file summary + d folder summaries, independent of repo size.

Summaries run with bounded concurrency (default 4) and a hard per-run cap on LLM calls (default 200) that the CLI shows before starting large jobs.

### 3. Context since last session

`cairn context --agent <id>`:

1. Snapshot the working tree → `now_tree`.
2. Load the agent's cursor. No cursor → return the repo map (step 5) and stop after step 6.
3. `git diff-tree -r --name-status <last_snapshot_tree> <now_tree>` → changed paths.
4. For each changed path: the unified diff if it is under a size limit (default 150 lines), else its new skeleton plus a note to read it.
5. Repo map: top-level folder summaries plus skeleton names for folders the agent touched recently.
6. Append open `session` and `task` records and the latest `decision` records for changed paths.
7. Update the cursor to `now_tree` only after the output is delivered.

### 4. Pack within a token budget

`cairn pack "<task>" --budget 8000 --model <id>`:

1. **Score** every file: keyword matches against skeleton symbol names and summaries (BM25), plus boosts for recently changed files, files linked to matching records, and one-hop import neighbours of top hits.
2. **Fill greedily** in score order with the cheapest form that still helps: full source (or only matching symbols' line ranges) for the top items, skeleton for the next, folder summary for the rest.
3. Stop when the next item would exceed the budget; always reserve 10% for records.
4. Output Markdown with a header listing what was included, at which layer, and the estimated tokens.

## Multi-agent support

Memory belongs to the repo, so any agent can continue another's work; this is CAIRN's main differentiator and lands in v0.3.

### Three integration levels

| Level | What the agent gets | How | Works with |
| --- | --- | --- | --- |
| 1. Instructions | Knows to call CAIRN before reading files | `cairn sync` writes a managed section into each agent's instruction file | All |
| 2. MCP tools | Can query context, why, pack, symbols | `cairn mcp` (stdio), registered by `cairn install <agent>` | All MCP-capable agents |
| 3. Auto-capture | Sessions and decisions recorded without asking | Agent-specific hooks or plugins | Where the tool offers hooks |

### Instruction sync

`cairn sync` writes or updates a block delimited by `<!-- cairn:start -->` and `<!-- cairn:end -->` in each existing instruction file: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/cairn.mdc`. It never touches text outside the markers. The block tells the agent to call `cairn_context` at session start, prefer `cairn_read_symbol` over whole-file reads, and record decisions with `cairn_note`.

### Adapters

Each adapter in `src/adapters/<agent>.ts` implements one interface:

```ts
interface Adapter {
  id: string;                          // "claude-code"
  detect(repo: string): Promise<boolean>;
  install(repo: string): Promise<InstallReport>;   // MCP config + hooks + instruction file
  uninstall(repo: string): Promise<void>;
  onSessionStart?(ctx: HookCtx): Promise<string>; // returns text injected into the agent's context
  onSessionEnd?(ctx: HookCtx): Promise<void>;     // writes a session record
}
```

- **Claude Code:** project MCP config plus hooks for session start (inject `cairn context`) and session end (write the session record).
- **OpenCode:** MCP config plus a plugin for the same two events.
- **Codex, Cursor, Gemini CLI:** MCP config and instruction file; add hooks where the tool supports them.
- **Generic fallback:** a git `post-commit` hook that writes a `session` record from the commit message and diff stats when no agent recorded one.

Before implementing each adapter, Claude Code must check that agent's current docs for config file locations and hook names, because they change often. Record what was verified in the adapter's header comment.

### Handoff

`cairn handoff [--to <agent>]` writes a `session` record and prints a briefing under 2,000 tokens:

- Active plan and task, and what's done
- Unfinished work: uncommitted files with one-line descriptions
- Decisions made this session
- Suggested next step, taken from the last session record

The next agent's `cairn context` includes the latest handoff automatically. The flow: work in Claude Code → run out of quota → `cairn handoff` → open OpenCode → it calls `cairn_context` and continues.

### Identity and tokens

- Agent id comes from `--agent`, the `CAIRN_AGENT` env var, or the adapter; with none of these it is `default`, and output includes a one-line hint to set one.
- `author.model` is filled when the agent reports it.
- Budgets are converted per model with a factor table in config (default 1.0 for the tiktoken estimate), because tokenizers differ.

## CLI and MCP interface

The CLI and MCP server call the same core functions; every MCP tool has a CLI equivalent so behaviour can be tested from the shell. All commands accept `--json` for machine output and `--agent <id>`.

### CLI

| Command | Does | Milestone |
| --- | --- | --- |
| `cairn init` | Create `.cairn/`, add it to `.gitignore`, write default config | v0.1 |
| `cairn map [path] [--depth n]` | Tree of folders with skeleton names, plus summaries when available | v0.1 |
| `cairn context` | Changes since this agent's last session, plus repo map and records | v0.1 |
| `cairn read <path>[#symbol]` | One symbol's source by line range, or the whole file | v0.1 |
| `cairn summarize [path]` | Build or refresh summaries for a path; shows LLM-call count first | v0.2 |
| `cairn stats [--since 7d]` | Tokens served vs. estimated full-read tokens | v0.2 |
| `cairn note "<intent>" [--decision …] [--rejected …]` | Attach a decision record to HEAD | v0.3 |
| `cairn why <path>` | Decision history for a path, newest first | v0.3 |
| `cairn sync` | Update managed sections in agent instruction files | v0.3 |
| `cairn install <agent>` / `uninstall` | Set up MCP config, hooks and instructions for one agent | v0.3 |
| `cairn handoff [--to <agent>]` | Write a session record and print the briefing | v0.3 |
| `cairn mcp` | Start the MCP server on stdio | v0.3 |
| `cairn pack "<task>" --budget n` | Budgeted context bundle in Markdown | v0.4 |
| `cairn bench <task-file>` | Run the token benchmark (see Testing) | v0.4 |
| `cairn ui [--port 4747]` | Start the local dashboard | v0.5 |
| `cairn plan add\|task\|list` | Plan and task records | v0.6 |
| `cairn release <version>` | Release record plus generated changelog | v0.6 |
| `cairn promote <release> --format post\|store\|tweet` | Draft launch copy from a release | v0.6 |
| `cairn doctor` | Check git version, config, cache integrity, adapters | v0.1 |

### MCP tools

| Tool | Input | Returns |
| --- | --- | --- |
| `cairn_context` | `{ agent? }` | Same as `cairn context` |
| `cairn_overview` | `{ path?, depth? }` | Same as `cairn map` |
| `cairn_read_symbol` | `{ path, symbol? }` | Source of one symbol, with line numbers |
| `cairn_why` | `{ path }` | Decision records for the path |
| `cairn_note` | `{ intent, decision?, rejected?, paths? }` | The created record id |
| `cairn_pack` | `{ task, budget, model? }` | Markdown bundle |
| `cairn_handoff` | `{ summary?, next_step? }` | The briefing |

Every MCP response ends with a one-line footer such as `cairn: served 2,140 tokens (est. full read 38,900)`, which also feeds `stats.jsonl`.

### Config (`.cairn/config.toml`)

```toml
[summarizer]
provider = "ollama"            # ollama | anthropic | openai-compatible | off
model = "qwen2.5-coder:7b"
max_calls_per_run = 200
concurrency = 4

[context]
max_diff_lines = 150

[models.factors]               # tokenizer correction per model family
"claude" = 1.0
"gpt" = 1.0
```

## Dashboard (`cairn ui`)

`cairn ui` serves a read-only local web app on `localhost:4747` that draws only data CAIRN already stores; it never calls an LLM.

| View | Shows | Built from |
| --- | --- | --- |
| Timeline | Sessions as bars per agent, handoffs as markers, commits as ticks | `session` records, git log |
| Codebase map | Treemap of folders sized by source tokens, coloured by recent change or summary coverage | snapshot tree, cache entries |
| Decisions | Records linked to files and commits; click a file to see its history | records, links |
| Savings | Tokens served vs. estimated full reads, per day and per agent | `stats.jsonl` |

- The server exposes a small JSON API (`/api/timeline`, `/api/map`, `/api/records`, `/api/stats`) that reuses core functions.
- Built with Vite + React, bundled into the npm package, so there's no separate install.
- Design: minimal, neutral palette, one accent colour per agent, light and dark themes.

## Lifecycle records: plan, release, promote

Lifecycle features are thin commands that write and read records; they add no new storage and no external integrations.

| Stage | Command | Reads | Writes |
| --- | --- | --- | --- |
| Plan | `cairn plan add "<goal>"`, `cairn plan task "<task>" --plan <id>` | — | `plan`, `task` |
| Build | `context`, `why`, `pack`, `note` | everything | `decision`, `session` |
| Ship | `cairn release 1.2.0` | `decision` and `task` records since the last release | `release` + `CHANGELOG.md` section |
| Promote | `cairn promote 1.2.0 --format post` | the `release` record and its linked decisions | `asset` + a Markdown file in `marketing/` |

- Plans and tasks appear in `cairn context`, so agents see why a feature exists and what's left.
- `release` groups decisions into Added, Changed and Fixed from their intent text; with the summarizer off it lists titles only.
- `promote` uses the configured summarizer with a format-specific prompt and writes a draft for the user to edit. It never posts anything anywhere.

## Security, privacy and failure modes

Nothing leaves the machine unless the user configures a cloud summarizer, and even then secrets and ignored files are never sent.

### Rules

- Never index or summarize anything git ignores, anything in `.cairnignore`, or built-in denies: `.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`, `secrets.*`, files over 1 MB, and binaries.
- Before any summarizer call, scan content for common secret patterns (API keys, private key headers, connection strings). On a hit, skip the file and log a warning without the matched text.
- Records may contain prompts. `cairn note --no-prompt` and the config flag `records.store_prompts = false` drop them. Warn the user once that `refs/notes/cairn` is pushed with the repo.
- The MCP server is read-only except `cairn_note` and `cairn_handoff`, which only write records.
- The dashboard binds to `127.0.0.1` only.

### Failure modes

| Situation | Behaviour |
| --- | --- |
| Summarizer down or not configured | Fall back to skeletons; say so in one line |
| Cache entry corrupt or wrong schema | Delete and rebuild that entry; `cairn doctor` reports it |
| Not a git repo, or git older than 2.38 | Clear error with the fix |
| Repo with no commits | Snapshot from an empty tree |
| Detached HEAD, rebase in progress, shallow clone | Works from the snapshot tree; records attach to HEAD |
| Summary contradicts the code | Every summary is labelled as a summary with its source hash; agents are told to verify with `cairn_read_symbol` before editing |
| Notes conflict after pull | Merge with `cat_sort_uniq`; duplicates removed by record id |

## Testing and benchmark

Every core function is tested against real temporary git repos, and the token-savings claim is proven by a reproducible benchmark before it goes in the README.

### Tests

- `test/fixtures/` builds repos from small scripts: TS app, Python package, Flutter/Dart app, Swift package, and a monorepo with 2,000 generated files.
- Unit tests for the cache key, snapshot, skeleton extraction per language, diff-to-context, and pack budgeting.
- Property test: for random edits, a cache lookup never returns an entry whose hash differs from the current content.
- Safety test: after every command, `.git/index`, `HEAD` and all refs except `refs/notes/cairn` are byte-identical.
- MCP tests: start the server, call each tool over stdio, and snapshot the output.
- Summarizer tests use a fake provider that returns deterministic text.

### Benchmark (`cairn bench`)

1. Pick three public repos of different sizes (for example a small Next.js app, a medium Python library, and a large TypeScript monorepo).
2. Write 10 task files per repo: questions ("where is X handled") and small changes ("add a flag to Y").
3. Run each task with the same agent and model twice: with CAIRN installed and without.
4. Record input tokens, tool calls, wall time, and whether the task succeeded (a human checks a sample).
5. Publish raw results in `bench/results/` and the method in `bench/README.md`.

The README headline uses the median saving across all tasks, never the best case.

## Roadmap and acceptance criteria

Six milestones, each shippable on its own; a milestone is done only when every box below it is ticked. v0.1 needs no LLM and should take a couple of weekends.

### v0.1 — Core memory, no AI

- [ ] Repo scaffolded: pnpm, TS strict, ESM, vitest, eslint, `bin/cairn`, CI on GitHub Actions (Linux + macOS)
- [ ] `src/git/` wrapper with typed helpers for rev-parse, ls-tree, diff-tree, notes, and the tmp-index snapshot
- [ ] `cairn init`, `cairn doctor`
- [ ] Skeletons for TypeScript/JavaScript, Python, Dart, Swift via web-tree-sitter, cached by blob hash
- [ ] `cairn map`, `cairn read <path>#<symbol>`
- [ ] `cairn context` with session cursors, working on uncommitted changes
- [ ] Safety test passes: user's index, HEAD and refs untouched
- [ ] `cairn map` on a 10,000-file repo: under 5 s cold, under 1 s warm

### v0.2 — Summaries

- [ ] Summarizer interface with Ollama and Anthropic providers plus a fake provider for tests
- [ ] Lazy bottom-up file and folder summaries keyed by content hash and generator id
- [ ] LLM-call cap and confirmation prompt for large runs
- [ ] Secret scan before every summarizer call
- [ ] `cairn stats` reads `stats.jsonl`
- [ ] Editing one file at depth 3 triggers exactly 4 summary calls

### v0.3 — Multi-agent

- [ ] Records in `refs/notes/cairn`, with `cairn note` and `cairn why`
- [ ] MCP server with all v0.3 tools and the savings footer
- [ ] `cairn sync` with managed instruction blocks
- [ ] Adapters: Claude Code and OpenCode with hooks; Codex, Cursor and Gemini CLI with MCP and instructions; generic post-commit fallback
- [ ] `cairn handoff`, and the next agent's `cairn context` includes it
- [ ] End-to-end test: a session in Claude Code, handoff, continued in OpenCode on a sample repo

### v0.4 — Pack and proof

- [ ] `cairn pack` with scoring, greedy fill and budget
- [ ] `cairn bench` and published results on three public repos
- [ ] README with the median saving and install in under 60 seconds
- [ ] First public npm release

### v0.5 — Dashboard

- [ ] `cairn ui` with the four views and JSON API
- [ ] Bound to localhost, works offline, light and dark themes

### v0.6 — Lifecycle

- [ ] `plan`, `task`, `release`, `promote` records and commands
- [ ] Plans and tasks shown in `cairn context`
- [ ] Generated `CHANGELOG.md` section and promotion drafts

## Open questions

Decide these before the milestone that needs them; Claude Code adds new ones here instead of guessing.

- [x] Is the name CAIRN free on npm, GitHub and a domain? (before v0.1) — **npm package `@emirucgun/cairn`, CLI command stays `cairn`** (decided 2026-11-27)
  - GitHub: free (repo `Emirucgun/CAIRN`). npm: unscoped `cairn` is taken, as are `cairn-cli`, `cairn-ai`, `cairn-mcp`, `cairn-memory`, `cairn-dev` and `cairnkit`, so we publish scoped. Install: `npm i -g @emirucgun/cairn`. Domain: not checked yet.
- [x] License: MIT, or Apache-2.0 for the patent grant? (before v0.1) — **MIT** (decided 2026-11-27; see `LICENSE`)
- [x] Cache entry `imports`: the cache is keyed by blob hash (path-independent), but resolved import paths depend on the file's location. Store raw specifiers and resolve at read time? (before v0.1, see docs/plans/v0.1.md Q1) — **Raw specifiers, resolved at read time** (decided 2026-11-27)
- [x] Skeleton `generator_id`: include language and extractor version, e.g. `ts:typescript@0.1.13+x1`, so query changes and .ts/.js differences invalidate the cache? (before v0.1, Q2) — **Yes, `ts:<lang>@<grammar-pkg-version>+x<extractor-version>`** (decided 2026-11-27)
- [x] Token counting: tiktoken over every source file is too slow for a cold 10k-file map. Use a chars/4 estimate for `tokens.source` and exact counts only for served text? (before v0.1, Q3) — **Yes: chars/4 for `tokens.source`, exact tiktoken for served text** (decided 2026-11-27)
- [x] Default agent id when no `--agent`, `CAIRN_AGENT` or adapter is present: `default`? (before v0.1, Q4) — **`default`, with a hint** (decided 2026-11-27)
- [ ] Default local model for summaries, chosen after testing 2–3 small coding models on quality vs. speed (before v0.2)
- [ ] Should summaries be shareable (pushed in a ref) so a team builds the cache once, or stay local? (before v0.3)
- [ ] Should prompts be stored in records by default, given they are pushed with the repo? (before v0.3)
- [ ] Pricing or sponsorship model, if any, after the first public release
