/**
 * The CI gate.
 *
 * Passed to Eval() as its third argument (see agent.eval.ts) and run by
 * `braintrust eval`, which uses its return value to set the process exit code.
 * This one checks every scorer against the limits in thresholds.json,
 * independently.
 *
 * Note the CLI matters: the newer `bt eval` does not run custom reporters and
 * exits 0 regardless, so the gate silently passes under it. Verified against
 * braintrust 3.29 / bt eval-runner 0.12.0.
 *
 * Independently is the whole point. A gate on one blended score cannot tell
 * "the agent got better" apart from "the agent got more fluent while it stopped
 * verifying its citations" — both raise the average. Per-scorer limits can.
 */

import { readFileSync } from "node:fs";

import { Reporter } from "braintrust";

import { evalsPath } from "../src/paths.js";

const { gates } = JSON.parse(readFileSync(evalsPath("thresholds.json"), "utf8")) as {
  gates: Record<string, { floor?: number; maxRegression?: number }>;
};

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const diff = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}`;

export const regressionGate = Reporter<{ name: string; url?: string; failures: string[] }>(
  "jwst-regression-gate",
  {
    reportEval(_evaluator, { summary }) {
      const scores = summary.scores ?? {};
      const failures: string[] = [];

      // A gate with nothing to check must fail, not pass. No scores means every
      // limit below is vacuously satisfied, and CI goes green on an eval that
      // never ran.
      if (Object.keys(scores).length === 0) {
        failures.push("no scores reported — nothing to check");
      }

      for (const [name, gate] of Object.entries(gates)) {
        const score = scores[name];
        if (!score) continue; // this scorer only produced skips on this run

        if (gate.floor !== undefined && score.score < gate.floor) {
          failures.push(`${name}: ${pct(score.score)} is below its floor of ${pct(gate.floor)}`);
        }
        // `diff` is the change against the base experiment, which Braintrust
        // picks from git history.
        if (gate.maxRegression !== undefined && score.diff !== undefined) {
          if (-score.diff > gate.maxRegression) {
            failures.push(
              `${name}: ${diff(score.diff)} exceeds its ${pct(gate.maxRegression)} drop limit`,
            );
          }
        }
      }

      console.log(`\n  ${summary.experimentName}`);
      for (const [name, score] of Object.entries(scores)) {
        const failed = failures.some((f) => f.startsWith(`${name}:`));
        const delta = score.diff !== undefined ? `  (${diff(score.diff)})` : "";
        console.log(
          `    ${failed ? "FAIL" : "ok  "}  ${name.padEnd(24)} ${pct(score.score).padStart(6)}${delta}`,
        );
      }

      return { name: summary.experimentName, url: summary.experimentUrl, failures };
    },

    reportRun(reports) {
      const failing = reports.filter((r) => r.failures.length > 0);
      console.log();

      if (failing.length === 0) {
        console.log(`All ${reports.length} run(s) passed.`);
        return true;
      }

      for (const r of failing) {
        console.log(`${r.name} failed:`);
        for (const f of r.failures) console.log(`  ✗ ${f}`);
        if (r.url) console.log(`  → ${r.url}`);
      }
      console.log("\nLimits are in evals/thresholds.json. Changing one is a reviewable diff.");

      // false → `braintrust eval` exits non-zero → the pull request is blocked.
      return false;
    },
  },
);
