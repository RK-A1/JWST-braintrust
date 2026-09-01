/**
 * The eval suite.
 *
 *   npx tsx evals/build_golden.ts     # regenerate fixtures (already committed)
 *   npx braintrust eval evals/                # run against Braintrust
 *
 * One experiment per prompt version, so the Braintrust UI can diff them
 * directly. Which versions run is controlled by PROMPT_VERSIONS:
 *
 *   PROMPT_VERSIONS=v1-grounded npx braintrust eval evals/          # baseline only
 *   PROMPT_VERSIONS=v1-grounded,v2-concise npx braintrust eval evals/   # the comparison
 *
 * Experiment metadata carries the model and prompt version, which is what makes
 * the comparison view useful — you can group by either and see the scorers move.
 */

import { readFileSync } from "node:fs";

import { Eval } from "braintrust";

import { DEFAULT_MODEL, runAgent } from "../src/agent.js";
import { dataPath } from "../src/paths.js";
import { PROMPT_VERSIONS, type PromptVersion } from "../src/prompts.js";
import type { GoldenCase } from "./build_golden.js";
import { allScorers } from "./scorers.js";

// The gate is passed as Eval()'s third argument, below. Exporting it is not
// enough — nothing registers exported reporters, so a Reporter that is only
// exported never runs and the build goes green with nothing checked.
import { regressionGate } from "./reporter.js";

const golden: { meta: Record<string, unknown>; cases: GoldenCase[] } = JSON.parse(
  readFileSync(dataPath("golden.json"), "utf8"),
);

const PROJECT = process.env.BRAINTRUST_PROJECT ?? "JWST Research Agent";
const MODEL = process.env.AGENT_MODEL ?? DEFAULT_MODEL;

/**
 * Trials matter more than usual here. The agent is non-deterministic, and the
 * regression this suite is designed to catch is a shift in *rate* — how often
 * the agent skips a verification step — not a hard failure. One trial per case
 * would put that shift inside the noise.
 */
const TRIAL_COUNT = Number(process.env.TRIAL_COUNT ?? 3);

/** Subset of cases, for fast smoke runs on pull requests. */
const LIMIT = process.env.EVAL_LIMIT ? Number(process.env.EVAL_LIMIT) : undefined;

/**
 * Take `n` cases spread evenly across the case types, not the first `n`.
 *
 * The golden file is grouped by type, so slicing from the front returns only
 * count questions — which skip both answer_quality and citation_grounding, the
 * two scorers that matter most. A smoke run that silently exercises neither is
 * worse than no smoke run, because it reports green.
 */
function spread(all: GoldenCase[], n: number): GoldenCase[] {
  const byType = new Map<string, GoldenCase[]>();
  for (const c of all) {
    const bucket = byType.get(c.metadata.case_type) ?? [];
    bucket.push(c);
    byType.set(c.metadata.case_type, bucket);
  }

  const buckets = [...byType.values()];
  const picked: GoldenCase[] = [];
  // Round-robin across types until we have enough.
  for (let i = 0; picked.length < n; i++) {
    let addedThisRound = false;
    for (const bucket of buckets) {
      if (i < bucket.length && picked.length < n) {
        picked.push(bucket[i]);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break; // exhausted every bucket
  }
  return picked;
}

function selectedVersions(): PromptVersion[] {
  const raw = process.env.PROMPT_VERSIONS;
  if (!raw) return ["v1-grounded"];
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((v) => !PROMPT_VERSIONS.includes(v as PromptVersion));
  if (unknown.length) {
    throw new Error(
      `Unknown prompt version(s): ${unknown.join(", ")}. Known: ${PROMPT_VERSIONS.join(", ")}`,
    );
  }
  return requested as PromptVersion[];
}

const cases = LIMIT ? spread(golden.cases, LIMIT) : golden.cases;

for (const promptVersion of selectedVersions()) {
  Eval(PROJECT, {
    // Just the prompt version by default: the two experiments being compared
    // should differ by exactly one visible thing. Model and trial count live in
    // metadata and tags, where they can be grouped on without cluttering the
    // comparison view.
    experimentName: process.env.EXPERIMENT_NAME ?? promptVersion,
    description:
      `JWST research agent — prompt ${promptVersion}, model ${MODEL}, ` +
      `${cases.length} cases x ${TRIAL_COUNT} trials.`,

    data: () =>
      cases.map((c) => ({
        input: c.input,
        expected: c.expected,
        // Case type and label land on every row, so the UI can slice scores by
        // question shape and by astronomical class without extra plumbing.
        metadata: c.metadata,
        tags: [c.metadata.case_type],
      })),

    task: async (input) => runAgent({ question: input.question, promptVersion, model: MODEL }),

    scores: allScorers,

    trialCount: TRIAL_COUNT,
    maxConcurrency: Number(process.env.MAX_CONCURRENCY ?? 4),

    // What this run is compared against — which is what makes the regression
    // limits in thresholds.json mean anything. Braintrust picks a base from git
    // history when this is unset; that works in CI but not on a branch with no
    // commits yet, so it is overridable:
    //   BASE_EXPERIMENT=v1-grounded-claude-haiku-4-5 npx braintrust eval evals/
    ...(process.env.BASE_EXPERIMENT
      ? { baseExperimentName: process.env.BASE_EXPERIMENT }
      : {}),

    metadata: {
      prompt_version: promptVersion,
      model: MODEL,
      trial_count: TRIAL_COUNT,
      case_count: cases.length,
      corpus_photo_count: golden.meta.corpus_photo_count,
    },
    tags: [promptVersion, MODEL],
  },
  // Third argument: the quality gate. This is what sets the exit code, and so
  // what actually blocks a pull request.
  { reporter: regressionGate });
}
