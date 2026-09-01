/**
 * The JWST corpus: 979 NASA Webb Flickr photos with weak ground-truth labels.
 *
 * Loaded from data/corpus.json, which is committed, so the agent and the evals
 * run from a fresh clone with no database and no image files.
 *
 * Search is a plain token-overlap scorer. It is deliberately the least
 * interesting part of this repo: the retriever is not what is being evaluated,
 * and a deterministic one means a failed eval case is always attributable to
 * the agent rather than to retrieval noise.
 */

import { readFileSync } from "node:fs";

import { dataPath } from "./paths.js";

export interface Photo {
  photo_id: string;
  title: string;
  description: string;
  tags: string[];
  canonical_label: string;
  date_taken: string | null;
  image_url: string;
}

export interface CorpusMeta {
  source: string;
  photo_count: number;
  label_counts: Record<string, number>;
  eval_labels: string[];
  min_label_count: number;
  note: string;
}

const file: { meta: CorpusMeta; photos: Photo[] } = JSON.parse(readFileSync(dataPath("corpus.json"), "utf8"));

export const meta: CorpusMeta = file.meta;
export const photos: Photo[] = file.photos;
export const labels: string[] = Object.keys(meta.label_counts).sort();

const byId = new Map(photos.map((p) => [p.photo_id, p]));

export function getPhoto(photoId: string): Photo | undefined {
  return byId.get(photoId);
}

export function photoExists(photoId: string): boolean {
  return byId.has(photoId);
}

export function countByLabel(): Record<string, number> {
  return { ...meta.label_counts };
}

// ── Search ──────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "and", "or", "to", "for", "with", "is",
  "are", "was", "were", "by", "at", "from", "as", "its", "this", "that",
  "what", "which", "how", "many", "find", "photo", "photos", "image", "images",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

const docTokens: Set<string>[] = photos.map(
  (p) => new Set(tokenize(`${p.title} ${p.description} ${p.tags.join(" ")}`)),
);
const titleTokens: Set<string>[] = photos.map((p) => new Set(tokenize(p.title)));

export interface SearchHit {
  photo_id: string;
  title: string;
  canonical_label: string;
  score: number;
}

/**
 * Rank by how many query terms a photo matches, weighting title matches double.
 * Ties break on photo_id so results are stable across runs.
 */
export function searchPhotos(query: string, limit = 8): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const scored = photos
    .map((photo, i) => {
      let score = 0;
      for (const term of terms) {
        if (titleTokens[i].has(term)) score += 2;
        else if (docTokens[i].has(term)) score += 1;
      }
      return { photo, score };
    })
    .filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score || a.photo.photo_id.localeCompare(b.photo.photo_id));

  return scored.slice(0, limit).map(({ photo, score }) => ({
    photo_id: photo.photo_id,
    title: photo.title,
    canonical_label: photo.canonical_label,
    score,
  }));
}
