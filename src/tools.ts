/**
 * Agent tools over the JWST corpus.
 *
 * Every tool body is wrapped in `wrapTraced` with `type: "tool"`, so each call
 * lands in Braintrust as its own child span with its arguments, its return
 * value, and its duration. That span type is not cosmetic: it is what
 * `trace.getSpans({ spanType: ["tool"] })` filters on in the trajectory scorer.
 */

import { wrapTraced } from "braintrust";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { countByLabel, getPhoto, searchPhotos } from "./corpus.js";

export const TOOL_NAMES = ["search_photos", "get_photo", "count_by_label"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const toolSchemas: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_photos",
      description:
        "Search photo titles, descriptions, and tags. Returns ranked matches " +
        "with their IDs and labels — summaries only. Call get_photo for the " +
        "full record, including the capture date.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search query." },
          limit: { type: "integer", description: "Max hits (default 8).", minimum: 1, maximum: 25 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_photo",
      description:
        "Retrieve the complete record for one photo by ID: title, description, " +
        "tags, canonical label, capture date, and image URL. This is the only " +
        "way to confirm that a photo ID actually exists.",
      parameters: {
        type: "object",
        properties: { photo_id: { type: "string", description: "The Flickr photo ID." } },
        required: ["photo_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "count_by_label",
      description:
        "Exact photo count for every canonical label in the corpus. Use this " +
        "for any 'how many' question — do not estimate from search results.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const tracedSearch = wrapTraced(
  async function search_photos({ query, limit }: { query: string; limit?: number }) {
    return { hits: searchPhotos(query, Math.min(limit ?? 8, 25)) };
  },
  { type: "tool" },
);

const tracedGetPhoto = wrapTraced(
  async function get_photo({ photo_id }: { photo_id: string }) {
    const photo = getPhoto(photo_id);
    // A miss is a signal, not an exception: it means the agent asked for an ID
    // that does not exist, which is exactly what the grounding scorer is about.
    if (!photo) return { found: false, photo_id, error: `No photo with ID ${photo_id}.` };
    return { found: true, ...photo };
  },
  { type: "tool" },
);

const tracedCountByLabel = wrapTraced(
  async function count_by_label() {
    const counts = countByLabel();
    return { total: Object.values(counts).reduce((a, b) => a + b, 0), counts };
  },
  { type: "tool" },
);

const registry: Record<string, (args: any) => Promise<unknown>> = {
  search_photos: tracedSearch,
  get_photo: tracedGetPhoto,
  count_by_label: tracedCountByLabel,
};

export async function callTool(name: string, args: unknown): Promise<unknown> {
  const impl = registry[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args ?? {});
}
