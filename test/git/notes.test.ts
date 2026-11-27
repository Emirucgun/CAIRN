import { describe, expect, it } from "vitest";
import { appendNote, listNotes, NOTES_REF, openRepo, readNote, removeNote, writeNote } from "../../src/git/index.js";
import { makeRepo, protectedState } from "../helpers/repo.js";

describe("notes", () => {
  it("is empty before the ref exists", async () => {
    const r = makeRepo({ "a.ts": "a" });
    const repo = await openRepo(r.dir);
    expect(await listNotes(repo)).toEqual([]);
    expect(await readNote(repo, "HEAD")).toBeNull();
  });

  it("writes JSON lines byte for byte and appends without blank lines", async () => {
    const r = makeRepo({ "a.ts": "a" });
    const repo = await openRepo(r.dir);
    const head = r.git("rev-parse", "HEAD").trim();
    const before = protectedState(r);

    const l1 = '{"schema":1,"id":"rec_1","body":"  # not a comment  "}\n';
    const l2 = '{"schema":1,"id":"rec_2"}\n';
    await writeNote(repo, head, l1);
    expect(await readNote(repo, head)).toBe(l1);
    await appendNote(repo, head, l2);
    expect(await readNote(repo, head)).toBe(l1 + l2);

    const notes = await listNotes(repo);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.target).toBe(head);
    expect(r.git("for-each-ref", "--format=%(refname)", "refs/notes/").trim()).toBe(NOTES_REF);
    expect(protectedState(r)).toEqual(before);

    await removeNote(repo, head);
    await removeNote(repo, head);
    expect(await readNote(repo, head)).toBeNull();
  });
});
