#!/usr/bin/env python3
"""
Build the self-contained JWST corpus that the agent and the eval suite run against.

Reads two private sources on the author's machine:

  1. ../JWST-langfuse/include/jwst.duckdb   — titles, descriptions, tags,
     canonical labels for ~4.3k NASA Webb Flickr photos.
  2. ../jwst-fireworks-poc/data/manifest.csv — public Flickr CDN URLs, already
     resolved via flickr.photos.getSizes.

Writes one committable artefact:

  data/corpus.json — every labelled photo with metadata and a public image URL.

The point is reproducibility. Nobody cloning this repo has the 76 MB DuckDB
file or the 285 MB image directory, but corpus.json is ~1 MB and every image is
a public URL, so the agent and every eval in this repo run from a fresh clone.

Usage:
    python data/build_corpus.py
    python data/build_corpus.py --out data/corpus.json --min-label-count 5
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

import duckdb

REPO = Path(__file__).resolve().parents[1]
DEFAULT_DB = REPO.parent / "JWST-langfuse" / "include" / "jwst.duckdb"
DEFAULT_MANIFEST = REPO.parent / "jwst-fireworks-poc" / "data" / "manifest.csv"
DEFAULT_OUT = REPO / "data" / "corpus.json"

# Labels with too few examples make per-class eval slices meaningless. The
# corpus keeps them, but records which labels cleared the bar so the eval suite
# can build a balanced golden set.
DEFAULT_MIN_LABEL_COUNT = 5


def load_manifest(path: Path) -> dict[str, str]:
    """Return {photo_id: public_image_url}."""
    if not path.exists():
        sys.exit(f"Manifest not found: {path}")
    with path.open(newline="") as fh:
        return {row["photo_id"]: row["url"] for row in csv.DictReader(fh) if row.get("url")}


def clean_description(text: str | None) -> str:
    """Flatten Flickr's newline-heavy descriptions and drop boilerplate credits."""
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text).strip()
    # Flickr descriptions tail off into image credits and alt-text blocks that
    # add tokens without adding information the agent can act on.
    for marker in ("Image Description:", "Credit:", "Image credit:", "Read more:"):
        idx = text.find(marker)
        if idx > 200:  # only truncate if we keep a usable amount of prose
            text = text[:idx].strip()
    return text


def load_photos(db_path: Path) -> list[dict]:
    if not db_path.exists():
        sys.exit(f"DuckDB not found: {db_path}")
    con = duckdb.connect(str(db_path), read_only=True)
    rows = con.execute(
        """
        SELECT photo_id, title, description, tags, canonical_label, date_taken
        FROM photos
        WHERE canonical_label IS NOT NULL
        ORDER BY photo_id
        """
    ).fetchall()
    con.close()
    return [
        {
            "photo_id": r[0],
            "title": (r[1] or "").strip(),
            "description": clean_description(r[2]),
            "tags": list(r[3] or []),
            "canonical_label": r[4],
            "date_taken": r[5].isoformat() if r[5] else None,
        }
        for r in rows
    ]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--min-label-count", type=int, default=DEFAULT_MIN_LABEL_COUNT)
    args = ap.parse_args()

    urls = load_manifest(args.manifest)
    photos = load_photos(args.db)

    # A photo only makes the corpus if it has a public URL — otherwise a fresh
    # clone could not reproduce the multimodal path.
    kept = []
    for p in photos:
        url = urls.get(p["photo_id"])
        if not url:
            continue
        kept.append({**p, "image_url": url})

    label_counts = Counter(p["canonical_label"] for p in kept)
    eval_labels = sorted(
        label for label, n in label_counts.items()
        if n >= args.min_label_count and label != "unclassified"
    )

    corpus = {
        "meta": {
            "source": "NASA Webb Telescope Flickr account (nasawebbtelescope)",
            "photo_count": len(kept),
            "label_counts": dict(label_counts.most_common()),
            "eval_labels": eval_labels,
            "min_label_count": args.min_label_count,
            "note": (
                "canonical_label is derived from Flickr tags by rule-based "
                "consolidation, not human annotation. It is a weak label: good "
                "enough to be ground truth for agent retrieval, and honest "
                "about being noisy."
            ),
        },
        "photos": kept,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(corpus, indent=2) + "\n")

    dropped = len(photos) - len(kept)
    size_mb = args.out.stat().st_size / 1e6
    print(f"Wrote {args.out}  ({len(kept)} photos, {size_mb:.1f} MB)")
    if dropped:
        print(f"  Dropped {dropped} photos with no public URL.")
    print(f"  Eval labels (n >= {args.min_label_count}): {', '.join(eval_labels)}")
    for label, n in label_counts.most_common():
        mark = " " if label in eval_labels else "*"
        print(f"    {mark} {label:<28} {n:>4}")
    if any(label not in eval_labels for label in label_counts):
        print("  * excluded from per-class eval slices (too few examples)")


if __name__ == "__main__":
    main()
