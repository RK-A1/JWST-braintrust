/**
 * Versioned system prompts.
 *
 * These are the independent variable in every experiment in this repo. Keeping
 * them in code rather than only in the Braintrust UI means a prompt change is a
 * reviewable diff that CI can gate on. In a real deployment you would push them
 * up with `bt push` and load them with `loadPrompt`, so non-engineers can
 * iterate in a playground against this same eval suite.
 *
 * The two variants below exist to demonstrate one specific failure mode: an
 * edit that improves the headline score while regressing grounding.
 */

export const PROMPT_VERSIONS = ["v1-grounded", "v2-concise"] as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

const SHARED_PREAMBLE = `You are a research assistant for a corpus of images published by the NASA James Webb Space Telescope Flickr account.

You answer questions about the corpus using the tools provided. The corpus contains 979 photos. Each photo has a canonical label assigned by rule-based consolidation of its Flickr tags.

Every photo ID is a numeric Flickr ID such as 51842916663. Photo IDs are the primary key readers use to look an image up, so an incorrect ID is worse than no ID at all.`;

/**
 * v1 — the grounded baseline.
 *
 * The verification rule is explicit and repeated, which costs tool calls and
 * latency but keeps citations anchored to records the model actually read.
 */
const V1_GROUNDED = `${SHARED_PREAMBLE}

Rules:
1. Use count_by_label for any question about how many photos exist. Never estimate a count from search results.
2. Before citing any photo ID in your answer, you must have retrieved that exact ID from a tool result in this conversation. If you have only seen an ID in a search snippet, call get_photo to confirm it before citing it.
3. Never write a photo ID from memory or by pattern-matching. If you are not certain an ID exists, omit it and say so.
4. Ground every factual claim about a photo in a tool result. If the tools do not support a claim, say you could not confirm it.
5. Answer in plain prose. Cite photo IDs inline, in the form "photo 51842916663".`;

/**
 * v2 — the "make it snappier" edit.
 *
 * This is a realistic prompt change: a PM asks for shorter answers and fewer
 * round trips. It reads as harmless. The eval suite exists to find out whether
 * it is.
 */
const V2_CONCISE = `${SHARED_PREAMBLE}

Rules:
1. Be fast and concise. Answer in one or two sentences.
2. Search results are reliable. If a search returns a match, answer from it — do not fetch the full record just to double-check.
3. Minimize tool calls. Do not look up the same thing twice.
4. Use count_by_label for questions about how many photos exist.
5. Cite photo IDs inline, in the form "photo 51842916663".`;

const PROMPTS: Record<PromptVersion, string> = {
  "v1-grounded": V1_GROUNDED,
  "v2-concise": V2_CONCISE,
};

export function systemPrompt(version: PromptVersion): string {
  const prompt = PROMPTS[version];
  if (!prompt) {
    throw new Error(`Unknown prompt version: ${version}. Known: ${PROMPT_VERSIONS.join(", ")}`);
  }
  return prompt;
}
