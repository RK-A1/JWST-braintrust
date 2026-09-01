/**
 * Build the golden eval set from the corpus.
 *
 *   npx tsx evals/build_golden.ts   →   data/golden.json (committed)
 *
 * Every expected value is read straight out of the corpus: the expected count
 * for "how many nebula photos" is the actual count, the expected label for a
 * lookup is the actual label. Nothing here is hand-written or model-generated,
 * so the fixtures cannot drift away from the data without this build failing.
 *
 * Three case shapes, one per tool path:
 *
 *   count             → count_by_label
 *   lookup            → get_photo          (the ID is given in the question)
 *   search_and_verify → search_photos, then get_photo
 *
 * The third shape is where the regression lives. The agent has to find a photo
 * and then retrieve it for a field search does not return, so an agent under
 * pressure to "minimize tool calls" will skip the second step and answer from
 * the search snippet — or from memory.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getPhoto, meta, photos, searchPhotos } from "../src/corpus.js";
import type { ToolName } from "../src/tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, "..", "data", "golden.json");

export type CaseType = "count" | "lookup" | "search_and_verify" | "disambiguate";

export interface GoldenCase {
  input: { question: string };
  expected: { answer: string; photo_ids: string[]; tools: ToolName[] };
  metadata: { case_type: CaseType; label?: string; optimal_tool_calls: number };
}

/**
 * Pick n photos from a group, the same way every time: sort by ID, take the
 * first n. No randomness, so rebuilding this file always produces the same
 * questions and a stale fixture set shows up as a diff.
 */
function pick<T extends { photo_id: string }>(items: T[], n: number): T[] {
  return [...items].sort((a, b) => a.photo_id.localeCompare(b.photo_id)).slice(0, n);
}

const evalLabels = meta.eval_labels;

// ── count ───────────────────────────────────────────────────────────────────

const countCases: GoldenCase[] = evalLabels.map((label) => ({
  input: { question: `How many photos in the corpus are labelled "${label}"?` },
  expected: { answer: String(meta.label_counts[label]), photo_ids: [], tools: ["count_by_label"] },
  metadata: { case_type: "count", label, optimal_tool_calls: 1 },
}));

// ── lookup ──────────────────────────────────────────────────────────────────

const lookupCases: GoldenCase[] = evalLabels.flatMap((label) =>
  pick(
    photos.filter((p) => p.canonical_label === label && p.title.length > 15),
    1,
  ).map((photo) => ({
    input: {
      question: `What is photo ${photo.photo_id} about, and what canonical label does it carry?`,
    },
    expected: {
      answer: `The photo is titled "${photo.title}". Its canonical label is "${label}".`,
      photo_ids: [photo.photo_id],
      tools: ["get_photo"] as ToolName[],
    },
    metadata: { case_type: "lookup" as CaseType, label, optimal_tool_calls: 1 },
  })),
);

// ── search_and_verify ───────────────────────────────────────────────────────

/**
 * The query is the photo's own title. That makes retrieval easy on purpose —
 * the point of this case is not whether the agent can find a needle, it is
 * whether it retrieves the record before citing an ID and a date from it.
 *
 * Each case is verified solvable before it is emitted, so a failure in an
 * experiment is always the agent's fault and never the fixture's.
 */
const searchCases: GoldenCase[] = evalLabels.flatMap((label) => {
  const candidates = photos.filter(
    (p) => p.canonical_label === label && p.title.length > 20 && p.date_taken,
  );
  const chosen: GoldenCase[] = [];

  for (const photo of pick(candidates, 8)) {
    if (chosen.length >= 2) break;

    const hits = searchPhotos(photo.title, 5);
    if (!hits.some((h) => h.photo_id === photo.photo_id)) continue;

    const date = photo.date_taken!.slice(0, 10);
    chosen.push({
      input: {
        question:
          `Find the photo titled "${photo.title}". Give me its photo ID and the date it was taken.`,
      },
      expected: {
        // The date is not in search results, so a correct trajectory has to
        // search and then retrieve.
        answer: `Photo ${photo.photo_id}, taken ${date}.`,
        photo_ids: [photo.photo_id],
        tools: ["search_photos", "get_photo"],
      },
      metadata: { case_type: "search_and_verify", label, optimal_tool_calls: 2 },
    });
  }
  return chosen;
});

// ── disambiguate ────────────────────────────────────────────────────────────

/**
 * The case that makes verification matter.
 *
 * Several photos match the search phrase, and only the full record carries the
 * capture date — so the sole way to tell them apart is to fetch the candidates.
 * An agent that trusts the first search hit answers confidently and wrongly.
 *
 * Note its citation still counts as "grounded": search really did return that
 * ID. That is exactly why tool_selection and required_citations exist next to
 * citation_grounding — one scorer cannot see this failure on its own.
 *
 * Verified at build time: the phrase must return several candidates, exactly
 * one of them may match the target year, and the top hit must NOT be the
 * answer — otherwise skipping verification succeeds by luck.
 */
const disambiguationCases: GoldenCase[] = (() => {
  const chosen: GoldenCase[] = [];

  for (const photo of photos) {
    if (chosen.length >= 20) break;
    if (!photo.date_taken || photo.title.length < 20) continue;

    const phrase = photo.title.split(/\s+/).slice(0, 3).join(" ");
    if (phrase.length < 8) continue;

    const hits = searchPhotos(phrase, 5);
    if (hits.length < 3) continue;
    if (!hits.some((h) => h.photo_id === photo.photo_id)) continue;
    if (hits[0].photo_id === photo.photo_id) continue;

    const year = photo.date_taken.slice(0, 4);
    const sameYear = hits.filter((h) => getPhoto(h.photo_id)?.date_taken?.startsWith(year));
    if (sameYear.length !== 1) continue;

    chosen.push({
      input: {
        question:
          `Several photos match "${phrase}". Which one was taken in ${year}? Give me its photo ID.`,
      },
      expected: {
        answer: `Photo ${photo.photo_id}, "${photo.title}", taken ${photo.date_taken.slice(0, 10)}.`,
        photo_ids: [photo.photo_id],
        tools: ["search_photos", "get_photo"],
      },
      metadata: {
        case_type: "disambiguate",
        label: photo.canonical_label,
        optimal_tool_calls: 3,
      },
    });
  }
  return chosen;
})();

// ── Build ───────────────────────────────────────────────────────────────────

const cases = [...countCases, ...lookupCases, ...searchCases, ...disambiguationCases];

const byType = cases.reduce<Record<string, number>>((acc, c) => {
  acc[c.metadata.case_type] = (acc[c.metadata.case_type] ?? 0) + 1;
  return acc;
}, {});

writeFileSync(
  OUT_PATH,
  JSON.stringify(
    {
      meta: {
        generated_from: "data/corpus.json",
        corpus_photo_count: meta.photo_count,
        case_count: cases.length,
        cases_by_type: byType,
        note:
          "Regenerate with `npx tsx evals/build_golden.ts`. Every expected value " +
          "is derived from the corpus, and every search case was verified " +
          "solvable by the retriever at build time.",
      },
      cases,
    },
    null,
    2,
  ) + "\n",
);

console.log(`Wrote ${OUT_PATH}  (${cases.length} cases)`);
for (const [type, n] of Object.entries(byType).sort()) {
  console.log(`  ${type.padEnd(20)} ${String(n).padStart(3)}`);
}
