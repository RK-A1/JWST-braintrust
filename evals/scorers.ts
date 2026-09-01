/**
 * Six scorers. Five are deterministic; one is an LLM judge.
 *
 * That ratio is the design stance. A count question has one right answer, so
 * grading it with a model is slower, costlier, and less reliable than comparing
 * two integers — a judge asked whether "92" matches "roughly 90" will sometimes
 * say yes. The judge is reserved for open prose.
 *
 * Braintrust records each scorer independently, which is what makes the central
 * claim of this repo checkable: you can see one dimension regress while the
 * headline average improves.
 */

// `Score` is re-exported by autoevals rather than by the braintrust package —
// both refer to the same { name, score, metadata } shape a scorer returns.
import { Factuality, type Score } from "autoevals";
import type { EvalScorerArgs, SpanData } from "braintrust";

import { photoExists } from "../src/corpus.js";
import type { AgentResult } from "../src/agent.js";
import type { GoldenCase } from "./build_golden.js";

type Args = EvalScorerArgs<
  GoldenCase["input"],
  AgentResult,
  GoldenCase["expected"],
  GoldenCase["metadata"]
>;

/** Flickr photo IDs are 10–12 digit numbers; nothing else in these answers is. */
const PHOTO_ID_RE = /\b\d{10,12}\b/g;

function citedIds(answer: string): string[] {
  return [...new Set(answer.match(PHOTO_ID_RE) ?? [])];
}

// ── 1. Citation grounding — the scorer the repo is built around ─────────────

/**
 * Every photo ID in the answer must have come back from a tool call in this
 * turn.
 *
 * Note what this does *not* check: whether the ID exists. An ID can exist and
 * still be ungrounded — if the model produced it from pretraining or by
 * guessing a plausible-looking number, it was not looked up, even when it
 * happens to be right. An existence check would score that as a pass and hide
 * the failure mode entirely. Existence is still reported in metadata, because
 * an ID that is both uncited and nonexistent is a different bug worth seeing.
 *
 * An answer citing no IDs scores `null` (skipped), never 1.0 — otherwise an
 * agent could max this metric by refusing to cite anything.
 */
export function citationGrounding({ output }: Args): Score {
  const cited = citedIds(output.answer);
  const retrieved = new Set(output.trajectory.flatMap((t) => t.returnedPhotoIds));

  if (cited.length === 0) {
    return {
      name: "citation_grounding",
      score: null,
      metadata: { cited: 0, reason: "answer cited no photo IDs" },
    };
  }

  const grounded = cited.filter((id) => retrieved.has(id));
  return {
    name: "citation_grounding",
    score: grounded.length / cited.length,
    metadata: {
      cited: cited.length,
      grounded: grounded.length,
      ungrounded_ids: cited.filter((id) => !retrieved.has(id)),
      // Cited an ID that is not in the corpus at all — outright fabrication.
      nonexistent_ids: cited.filter((id) => !photoExists(id)),
    },
  };
}

// ── 2. Tool selection ───────────────────────────────────────────────────────

/**
 * Did the trajectory contain the tools the case requires?
 *
 * This is the complement to citation_grounding, not a duplicate of it. Search
 * results include photo IDs, so citing one straight from a search snippet
 * counts as grounded — correctly, since a tool did return it. What that agent
 * skipped is the *verification* step, and this is the scorer that sees it.
 */
export function toolSelection({ output, expected }: Args): Score {
  const required = expected.tools;
  if (required.length === 0) {
    return { name: "tool_selection", score: null, metadata: { reason: "no required tools" } };
  }
  const used = new Set(output.trajectory.map((t) => t.name));
  const hit = required.filter((t) => used.has(t));
  return {
    name: "tool_selection",
    score: hit.length / required.length,
    metadata: { required, used: [...used], missing: required.filter((t) => !used.has(t)) },
  };
}

// ── 3. Required citations ───────────────────────────────────────────────────

/**
 * Did the answer cite the photo the question was actually about?
 *
 * This is the scorer that sees a *confidently wrong* answer. On a
 * disambiguation question several photos match the search, and an agent that
 * skips the record lookup cites the top hit — which is never the right one.
 * That citation passes citation_grounding (search did return it) and reads
 * perfectly well. Only comparing against the known answer catches it.
 */
export function requiredCitations({ output, expected }: Args): Score {
  const required = expected.photo_ids;
  if (required.length === 0) {
    return { name: "required_citations", score: null, metadata: { reason: "no specific photo" } };
  }
  const cited = new Set(citedIds(output.answer));
  const hit = required.filter((id) => cited.has(id));
  return {
    name: "required_citations",
    score: hit.length / required.length,
    metadata: { required, cited: [...cited], missing: required.filter((id) => !cited.has(id)) },
  };
}

// ── 4. Count accuracy ───────────────────────────────────────────────────────

export function countAccuracy({ output, expected, metadata }: Args): Score {
  if (metadata.case_type !== "count") {
    return { name: "count_accuracy", score: null, metadata: { reason: "not a count case" } };
  }
  const target = Number(expected.answer);
  // 1–6 digits only, so a cited photo ID cannot be misread as the count.
  const numbers = (output.answer.match(/\b\d{1,6}\b/g) ?? []).map(Number);
  return {
    name: "count_accuracy",
    score: numbers.includes(target) ? 1 : 0,
    metadata: { expected: target, numbers_in_answer: numbers },
  };
}

// ── 5. Trajectory efficiency (trace-level) ──────────────────────────────────

/**
 * How close the agent came to the optimal number of tool calls.
 *
 * This reads the **span tree**, not the task's return value. Offline that is
 * the harder way to do it — the output is right there. But the same scorer has
 * to run against production logs, where no return value exists and all you have
 * is the trace. Writing it against `getSpans()` means one implementation serves
 * both offline experiments and online scoring.
 *
 * It rewards *fewer* tool calls, so on its own it would endorse an agent that
 * stops looking things up. That is exactly why it is read next to
 * citation_grounding and tool_selection, and never instead of them.
 */
export async function trajectoryEfficiency({ output, metadata, trace }: Args): Promise<Score> {
  const optimal = metadata.optimal_tool_calls;
  let actual = output.trajectory.length;
  let source = "output";

  if (trace) {
    try {
      const spans: SpanData[] = await trace.getSpans({ spanType: ["tool"] });
      actual = spans.length;
      source = "trace";
    } catch {
      // Spans may not have flushed, or the run is offline. The returned
      // trajectory is an accurate fallback, so degrade rather than fail.
    }
  }

  if (actual === 0) {
    return {
      name: "trajectory_efficiency",
      score: 0,
      metadata: { optimal, actual, source, reason: "agent used no tools" },
    };
  }

  return {
    name: "trajectory_efficiency",
    score: Math.min(1, optimal / actual),
    metadata: { optimal, actual, source, excess_calls: Math.max(0, actual - optimal) },
  };
}

// ── 6. Answer quality (LLM judge) ───────────────────────────────────────────

/** autoevals' Factuality judge, skipped where a deterministic scorer is better. */
export async function answerQuality({ input, output, expected, metadata }: Args): Promise<Score> {
  if (metadata.case_type === "count") {
    return { name: "answer_quality", score: null, metadata: { reason: "graded by count_accuracy" } };
  }

  // No `client` is passed on purpose. autoevals reaches models through the
  // Braintrust gateway by default, and it wraps any client handed to it that is
  // not already wrapped — which, under a runner that has auto-instrumented the
  // SDK, logs every judge call twice at double the tokens. Letting it use its
  // own client keeps one span per call and still reaches Claude.
  const result = await Factuality({
    input: input.question,
    output: output.answer,
    expected: expected.answer,
    model: process.env.JUDGE_MODEL ?? "claude-haiku-4-5",
  });

  return { name: "answer_quality", score: result.score ?? null, metadata: result.metadata ?? {} };
}

export const allScorers = [
  answerQuality,
  citationGrounding,
  requiredCitations,
  toolSelection,
  countAccuracy,
  trajectoryEfficiency,
];
