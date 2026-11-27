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
