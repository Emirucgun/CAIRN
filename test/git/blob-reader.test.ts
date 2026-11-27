import { describe, expect, it } from "vitest";
import { BlobReader, MissingObjectError, openRepo } from "../../src/git/index.js";
import { makeRepo } from "../helpers/repo.js";

describe("BlobReader", () => {
  it("reads many blobs, concurrently and in any size, through one process", async () => {
    const big = "x".repeat(300_000) + "\n";
    const r = makeRepo({ "a.txt": "alpha\n", "b.txt": "", "big.txt": big, "nl.txt": "\n\n\n" });
    const repo = await openRepo(r.dir);
    const reader = new BlobReader(repo);
    const hash = (p: string) => r.git("rev-parse", `HEAD:${p}`).trim();
    try {
      const out = await Promise.all(["a.txt", "b.txt", "big.txt", "nl.txt", "a.txt"].map((p) => reader.read(hash(p))));
      expect(out.map((b) => b.toString())).toEqual(["alpha\n", "", big, "\n\n\n", "alpha\n"]);
    } finally {
      await reader.close();
    }
  });

  it("rejects a missing object without breaking later reads", async () => {
    const r = makeRepo({ "a.txt": "alpha\n" });
    const reader = new BlobReader(await openRepo(r.dir));
    try {
      await expect(reader.read("0".repeat(40))).rejects.toBeInstanceOf(MissingObjectError);
      expect((await reader.read(r.git("rev-parse", "HEAD:a.txt").trim())).toString()).toBe("alpha\n");
      await expect(reader.read("not-a-hash")).rejects.toThrow(/not an object hash/);
    } finally {
      await reader.close();
    }
  });

  it("can be closed without ever being used, and twice", async () => {
    const reader = new BlobReader(await openRepo(makeRepo().dir));
    await reader.close();
    await reader.close();
  });
});
