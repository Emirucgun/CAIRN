// Imported first by every entry point, before any WebAssembly is compiled.
//
// --liftoff-only: run tree-sitter grammars on V8's baseline WebAssembly
// compiler and never tier up to TurboFan. Measured on Node 22: parsing even
// one Swift file made TurboFan compile the 3 MB Swift grammar in the
// background for ~13 s, and the process (or a worker's terminate()) waited
// for it before exiting. Liftoff parses ~1.6x slower; the parse pool
// (core/skeleton/pool.ts) more than makes up for it on large runs, and short
// runs never benefit from TurboFan's background work anyway.
import { setFlagsFromString } from "node:v8";

setFlagsFromString("--liftoff-only");
