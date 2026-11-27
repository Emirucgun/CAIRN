import type { Command } from "commander";
import { advanceCursor, buildContext, type ContextChange, type ContextResult } from "../core/context.js";
import { resolveAgent } from "../core/sessions.js";
import { renderSymbol } from "../core/skeleton/index.js";
import { withWorkspace } from "../core/workspace.js";
import { emit, type GlobalOptions, type Io } from "./io.js";
import { renderMap } from "./map.js";
import { logServe } from "./stats-log.js";

const STATUS = { A: "added", M: "modified", D: "deleted", T: "type changed" } as const;
const WITHHELD = {
  secret: "content withheld: looks like it contains a secret",
  binary: "binary",
  "too-large": "over 1 MiB, not diffed",
} as const;

function ago(iso: string, now: Date): string {
  const mins = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function renderChange(c: ContextChange): string {
  const head = `### ${STATUS[c.status]}: ${c.path}`;
  const d = c.detail;
  switch (d.kind) {
    case "diff":
      return `${head} (+${d.added} −${d.removed})\n\n\`\`\`diff\n${d.patch.trimEnd()}\n\`\`\``;
    case "skeleton": {
      const syms = d.symbols.length ? d.symbols.map((s) => `    ${renderSymbol(s)}`).join("\n") : "    (no symbols)";
      return `${head}\n\nDiff is ${d.diffLines} lines, over the limit. Current symbols:\n\n${syms}\n\nRead what you need: \`cairn read ${c.path}#<symbol>\``;
    }
    case "withheld":
      return `${head} (${WITHHELD[d.reason]})`;
    case "deleted":
    case "listed":
      return head;
  }
}

export function renderContext(r: ContextResult, now = new Date()): string {
  const out: string[] = [`# CAIRN context for ${r.agent.id}`, ""];
  if (r.agent.source === "default") {
    out.push("_Agent id is `default`. Pass `--agent <id>` or set `CAIRN_AGENT` so each agent keeps its own place._", "");
  }

  if (!r.since) {
    const why = {
      "new-agent": "First session for this agent",
      "cursor-unreadable": "This agent's session cursor was unreadable",
      "snapshot-pruned": "The snapshot from this agent's last session was pruned by `git gc`",
    }[r.firstReason ?? "new-agent"];
    out.push(`${why}: here is the repo map. Next time you will get only what changed.`, "", "## Repo map", "", "```", ...renderMap(r.map.root), "```");
  } else {
    const nChanged = r.changes.length + r.moreChanges;
    out.push(`Last session ${ago(r.since.seen, now)} (${r.since.seen}).`);
    if (nChanged === 0 && r.commitCount === 0) {
      out.push("", "Nothing changed since then.");
    } else {
      if (r.historyRewritten) {
        out.push("", "_HEAD's history was rewritten since then (the old HEAD is gone), so commits are not listed._");
      }
      if (r.commitCount > 0) {
        out.push("", `## Commits since then (${r.commitCount})`, "");
        for (const c of r.commits) out.push(`- ${c.hash.slice(0, 8)} ${c.subject} (${c.author})`);
        if (r.commitCount > r.commits.length) out.push(`- … ${r.commitCount - r.commits.length} older`);
      }
      out.push("", `## Changed files (${nChanged})`, "");
      const detailed = r.changes.filter((c) => c.detail.kind !== "listed");
      const listed = r.changes.filter((c) => c.detail.kind === "listed");
      out.push(detailed.map(renderChange).join("\n\n"));
      if (listed.length) {
        out.push("", "Also changed:", "", ...listed.map((c) => `- ${STATUS[c.status]}: ${c.path}`));
      }
      if (r.moreChanges > 0) out.push("", `… and ${r.moreChanges} more files.`);
    }
    out.push("", "## Repo map", "", "```", ...renderMap(r.map.root));
    for (const t of r.touched) out.push("", ...renderMap(t.root));
    out.push("```");
  }
  out.push("", "Use `cairn read <path>#<symbol>` for exact source before editing.", "");
  return out.join("\n");
}

export function registerContext(program: Command, io: Io): void {
  program
    .command("context")
    .description("what changed since this agent's last session, plus a repo map")
    .option("--no-advance", "show context without moving this agent's cursor")
    .action(async (opts: { advance: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const agent = resolveAgent(g.agent, io.env);
      await withWorkspace(io.cwd, async (ws) => {
        const result = await buildContext(ws, agent);
        const out = emit(io, g, { ...result, warnings: ws.warnings }, () => renderContext(result));
        for (const w of ws.warnings) io.err(`cairn: ${w}\n`);
        // SPEC: update the cursor only after the output is delivered.
        await io.flush?.();
        if (opts.advance) await advanceCursor(ws, result);
        logServe(ws, g, io, "context", out, result.fullReadTokens);
      });
    });
}
