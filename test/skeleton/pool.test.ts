import { describe, expect, it } from "vitest";
import { extractSkeleton } from "../../src/core/skeleton/extract.js";
import { ParsePool } from "../../src/core/skeleton/pool.js";

const FILES = [
  { lang: "typescript", src: "export function a(x: number): string { return String(x); }\n" },
  { lang: "python", src: "def b(y: int) -> int:\n    return y\n" },
  { lang: "dart", src: "int c(int z) => z;\n" },
  { lang: "swift", src: "public func d() -> Int { 1 }\n" },
] as const;

describe("ParsePool", () => {
  it("extracts the same skeletons as inline parsing, for every language", async () => {
    const pool = new ParsePool(2);
    try {
      const results = await Promise.all(FILES.map((f) => Promise.all([pool.extract(f.lang, f.src), extractSkeleton(f.lang, f.src)])));
      for (const [fromPool, inline] of results) expect(fromPool).toEqual(inline);
      expect(results.map(([e]) => e.skeleton[0]?.sym)).toEqual(["a", "b", "c", "d"]);
    } finally {
      await pool.close();
    }
  });

  it("rejects a failing request without breaking the next one", async () => {
    const pool = new ParsePool(1);
    try {
      await expect(pool.extract("cobol" as never, "x")).rejects.toThrow(/no skeleton extractor/);
      expect((await pool.extract("typescript", "export const y = 1;\n")).skeleton[0]?.sym).toBe("y");
    } finally {
      await pool.close();
    }
  });

  it("can be closed without starting", async () => {
    await new ParsePool().close();
  });
});
