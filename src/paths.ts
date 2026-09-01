/**
 * Locating the repo's data files.
 *
 * The obvious way to anchor a path is `import.meta.url`. It does not work here:
 * `braintrust eval` bundles the suite to CommonJS, where `import.meta` is empty,
 * so every path derived from it comes out `undefined` and the run dies before a
 * single case executes — with an error that points at `path`, not at the cause.
 *
 * Walking up from the working directory to the nearest package.json works under
 * both module formats and under any runner.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let cached: string | undefined;

export function repoRoot(): string {
  if (cached) return cached;

  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      cached = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find the repo root: no package.json at or above ${process.cwd()}. ` +
          "Run commands from inside the project directory.",
      );
    }
    dir = parent;
  }
}

export const dataPath = (file: string): string => join(repoRoot(), "data", file);
export const evalsPath = (file: string): string => join(repoRoot(), "evals", file);
