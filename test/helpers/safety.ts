// The SPEC safety rule as a test helper: after a command, the user's
// .git/index, HEAD and every ref except refs/notes/cairn are byte-identical.
//
//   const done = guard(repo);   // just before running the command
//   await runCommand(...);
//   // checked automatically after the test; or call done() to check now
import { afterEach, expect } from "vitest";
import { protectedState, type TempRepo } from "./repo.js";

const pending: (() => void)[] = [];

afterEach(() => {
  const checks = pending.splice(0);
  for (const check of checks) check();
});

export function guard(repo: TempRepo): () => void {
  const before = protectedState(repo);
  let checked = false;
  const check = () => {
    if (checked) return;
    checked = true;
    expect(protectedState(repo), `safety rule violated in ${repo.dir}`).toEqual(before);
  };
  pending.push(check);
  return check;
}
