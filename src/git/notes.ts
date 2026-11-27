// Read and write CAIRN's notes ref. Records (v0.3) are JSON lines stored as
// the note on a commit; this module only moves bytes and never parses them.
import { runGit } from "./exec.js";
import type { Repo } from "./repo.js";

export const NOTES_REF = "refs/notes/cairn";

export interface NoteEntry {
  /** Hash of the note blob. */
  note: string;
  /** The object (normally a commit) the note is attached to. */
  target: string;
}

const base = ["notes", `--ref=${NOTES_REF}`];

/** The note text on `target`, or null if it has none. */
export async function readNote(repo: Repo, target: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit([...base, "show", "--end-of-options", target], {
    cwd: repo.root,
    okExitCodes: [1],
  });
  return exitCode === 0 ? stdout : null;
}

/**
 * Replaces the note on `target` with exactly `text`. The text is first written
 * as a blob and attached with `-C`, which skips git's message cleanup, so
 * JSON lines are stored byte for byte.
 */
export async function writeNote(repo: Repo, target: string, text: string): Promise<void> {
  const blob = (
    await runGit(["hash-object", "-w", "--stdin"], { cwd: repo.root, input: text })
  ).stdout.trim();
  await runGit([...base, "add", "--force", "-C", blob, "--end-of-options", target], { cwd: repo.root });
}

/** Appends `text` to the note on `target`, without the blank line `git notes append` inserts. */
export async function appendNote(repo: Repo, target: string, text: string): Promise<void> {
  const existing = (await readNote(repo, target)) ?? "";
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await writeNote(repo, target, existing + sep + text);
}

/** Removes the note on `target`; a missing note is not an error. */
export async function removeNote(repo: Repo, target: string): Promise<void> {
  await runGit([...base, "remove", "--ignore-missing", "--end-of-options", target], { cwd: repo.root });
}

/** Every note under the CAIRN ref. Empty if the ref does not exist yet. */
export async function listNotes(repo: Repo): Promise<NoteEntry[]> {
  const { stdout } = await runGit([...base, "list"], { cwd: repo.root });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [note, target] = line.split(" ");
      if (!note || !target) throw new Error(`unexpected notes list line: ${line}`);
      return { note, target };
    });
}
