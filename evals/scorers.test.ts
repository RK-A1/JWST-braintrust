/**
 * Unit tests for the deterministic scorers.
 *
 *   npx tsx --test evals/scorers.test.ts
 *
 * A scorer is the measuring instrument. If it is wrong, every experiment built
 * on it is wrong in a way that looks like a real result — so the scorers get
 * tested even though the agent itself can only be evaluated statistically.
 *
 * No API key and no network: `answerQuality` is an LLM judge and is exercised
 * by the eval suite instead.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentResult } from "../src/agent.js";
import { photos } from "../src/corpus.js";
import {
  citationGrounding,
  countAccuracy,
  toolSelection,
  trajectoryEfficiency,
} from "./scorers.js";

// Two real IDs from the corpus, plus one that cannot exist.
const REAL_A = photos[0].photo_id;
const REAL_B = photos[1].photo_id;
const FAKE = "99999999999";

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    answer: "",
    trajectory: [],
    steps: 1,
    truncated: false,
    model: "test",
    promptVersion: "v1-grounded",
    ...overrides,
  };
}

function args(output: AgentResult, expected = {}, metadata = {}) {
  return {
    input: { question: "q" },
    output,
    expected: { answer: "", photo_ids: [], tools: [], ...expected },
    metadata: { case_type: "lookup", optimal_tool_calls: 1, ...metadata },
  } as any;
}

function retrieved(...ids: string[]) {
  return [{ name: "get_photo", args: {}, returnedPhotoIds: ids, durationMs: 1 }];
}

// ── citation_grounding ──────────────────────────────────────────────────────

test("grounding: a cited ID that was retrieved scores 1", () => {
  const score = citationGrounding(
    args(result({ answer: `See photo ${REAL_A}.`, trajectory: retrieved(REAL_A) })),
  );
  assert.equal(score.score, 1);
});

test("grounding: a real ID that was never retrieved is not grounded", () => {
  // The case the whole repo turns on. The ID is genuine, so an existence check
  // would pass it. The agent still never looked it up.
  const score = citationGrounding(
    args(result({ answer: `See photo ${REAL_B}.`, trajectory: retrieved(REAL_A) })),
  );
  assert.equal(score.score, 0);
  assert.deepEqual(score.metadata?.ungrounded_ids, [REAL_B]);
  assert.deepEqual(score.metadata?.nonexistent_ids, []);
});

test("grounding: a fabricated ID is flagged as nonexistent", () => {
  const score = citationGrounding(
    args(result({ answer: `See photo ${FAKE}.`, trajectory: retrieved(REAL_A) })),
  );
  assert.equal(score.score, 0);
  assert.deepEqual(score.metadata?.nonexistent_ids, [FAKE]);
});

test("grounding: partial credit across mixed citations", () => {
  const score = citationGrounding(
    args(result({ answer: `Photos ${REAL_A} and ${FAKE}.`, trajectory: retrieved(REAL_A) })),
  );
  assert.equal(score.score, 0.5);
});

test("grounding: an answer with no citations is skipped, not passed", () => {
  // Scoring silence as 1.0 would let an agent max this metric by citing nothing.
  assert.equal(citationGrounding(args(result({ answer: "I could not determine that." }))).score, null);
});

// ── tool_selection ──────────────────────────────────────────────────────────

test("tool_selection: full credit when every required tool was used", () => {
  const output = result({
    trajectory: [
      { name: "search_photos", args: {}, returnedPhotoIds: [], durationMs: 1 },
      { name: "get_photo", args: {}, returnedPhotoIds: [], durationMs: 1 },
    ],
  });
  assert.equal(toolSelection(args(output, { tools: ["search_photos", "get_photo"] })).score, 1);
});

test("tool_selection: catches the skipped verification step", () => {
  // Searched but never retrieved: citation_grounding still passes, because
  // search returned the ID. This is the scorer that sees the missing step.
  const output = result({
    trajectory: [{ name: "search_photos", args: {}, returnedPhotoIds: [REAL_A], durationMs: 1 }],
  });
  const score = toolSelection(args(output, { tools: ["search_photos", "get_photo"] }));
  assert.equal(score.score, 0.5);
  assert.deepEqual(score.metadata?.missing, ["get_photo"]);

  const grounding = citationGrounding(
    args(result({ answer: `Photo ${REAL_A}.`, trajectory: output.trajectory })),
  );
  assert.equal(grounding.score, 1, "grounding passes — the two scorers are complementary");
});

// ── count_accuracy ──────────────────────────────────────────────────────────

test("count_accuracy: finds the expected integer in prose", () => {
  const score = countAccuracy(
    args(result({ answer: "There are 42 nebula photos." }), { answer: "42" }, { case_type: "count" }),
  );
  assert.equal(score.score, 1);
});

test("count_accuracy: a wrong count fails", () => {
  const score = countAccuracy(
    args(result({ answer: "There are 41 nebula photos." }), { answer: "42" }, { case_type: "count" }),
  );
  assert.equal(score.score, 0);
});

test("count_accuracy: a cited photo ID is not mistaken for the count", () => {
  const score = countAccuracy(
    args(result({ answer: `Photo ${REAL_A} is one of 42.` }), { answer: "42" }, { case_type: "count" }),
  );
  assert.equal(score.score, 1);
  assert.ok(!(score.metadata?.numbers_in_answer as number[]).includes(Number(REAL_A)));
});

// ── trajectory_efficiency ───────────────────────────────────────────────────

test("efficiency: an optimal trajectory scores 1", async () => {
  const score = await trajectoryEfficiency(args(result({ trajectory: retrieved(REAL_A) })));
  assert.equal(score.score, 1);
});

test("efficiency: redundant calls are penalised proportionally", async () => {
  const output = result({ trajectory: [...retrieved(REAL_A), ...retrieved(REAL_A)] });
  const score = await trajectoryEfficiency(args(output));
  assert.equal(score.score, 0.5);
  assert.equal(score.metadata?.excess_calls, 1);
});

test("efficiency: using no tools scores 0, not infinity", async () => {
  assert.equal((await trajectoryEfficiency(args(result()))).score, 0);
});

test("efficiency: never exceeds 1 when the agent beats the estimate", async () => {
  const score = await trajectoryEfficiency(
    args(result({ trajectory: retrieved(REAL_A) }), {}, { optimal_tool_calls: 3 }),
  );
  assert.equal(score.score, 1);
});
