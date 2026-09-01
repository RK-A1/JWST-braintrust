# Migrating from Langfuse to Braintrust

Before this project I built [a Langfuse-instrumented pipeline](https://github.com/RK-A1/JWST_Langfuse)
on the same JWST photo corpus: a vision model classifying images, traced end to
end, with evaluation scores pushed back afterwards to close the loop. The
workload is different from the tool-calling agent here, but the corpus and the
instrumentation questions are the same, which is what makes the comparison
below a practical one rather than a feature-table exercise. This document is the
mapping I would have wanted on day one, written from having built on both.

It is deliberately factual. Both tools are good at what they were designed
around, and the honest summary is that they were designed around **different
centres of gravity**. Knowing which one a team actually needs is more useful to
them than a feature-count argument.

---

## The one-paragraph version

Langfuse is **trace-first**: you instrument, you look at traces, and evaluation
is something you attach to traces afterward. Braintrust is **eval-first**: the
unit of work is an experiment over a dataset, and tracing is what makes an
experiment debuggable. If your immediate problem is *"I cannot see what my app
did"*, either works. If it is *"I cannot tell whether this change made things
better"*, that is the axis Braintrust is built along, and the difference shows
up most in CI.

---

## Concept mapping

| Langfuse | Braintrust | Notes |
|---|---|---|
| `@observe` decorator | `@traced` / `wrapTraced` | Direct equivalent. |
| Trace | Trace | Same idea; Braintrust types spans (`llm`, `tool`, `function`, `score`). |
| Observation / span | Span | Braintrust's `span_attributes.type` is what trace-level scorers filter on. |
| Score (`create_score`) | Score | Langfuse: pushed post hoc by ID. Braintrust: usually returned by a scorer during the eval. |
| Dataset | Dataset | Both versioned. Braintrust's plugs directly into `Eval()`. |
| Dataset run | **Experiment** | The big one. See below. |
| Prompt management | Prompts + Playgrounds | Comparable; Braintrust playgrounds run the eval suite interactively. |
| — | **`Eval()` + `bt eval`** | No direct Langfuse equivalent as a first-class primitive. |
| — | **`Reporter`** | Custom CI pass/fail logic. |
| — | **Trace-level scorers** | `trace.getSpans()` inside a scorer. |
| ClickHouse (storage) | Brainstore (storage) | Both columnar-ish; different engines, similar role. |

---

## What ports over almost unchanged

Instrumentation. This is the Langfuse version from the original project:

```python
@observe(as_type="generation", name="vlm-classify")
async def classify_image(photo_id: str, image_bytes: bytes) -> dict:
    response = await client.chat(model=MODEL, messages=[...])
    langfuse.update_current_generation(
        input={"photo_id": photo_id},
        output=result,
        usage_details={"input": in_tok, "output": out_tok},
    )
```

and the Braintrust equivalent:

```python
@traced(type="tool", name="get_photo")
def _get_photo(photo_id: str) -> dict[str, Any]:
    ...
```

Two differences worth knowing:

1. **Token and cost capture is automatic** if you wrap the client
   (`wrap_openai` / `wrapOpenAI`). The Langfuse version above threads
   `usage_details` through by hand because it calls Ollama directly.
2. **Span type is a first-class field.** Tagging a span `tool` is not cosmetic —
   it is what `trace.getSpans({spanType: ["tool"]})` filters on, so trajectory
   scoring depends on getting it right.

---

## What changes shape

### Scoring moves from after-the-fact to inline

The Langfuse project scored by listing traces, joining them back to ground truth
on `metadata.photo_id`, and pushing scores by trace ID:

```python
photo_to_trace = fetch_traces(api, limit)      # page through the API
for p in predictions:
    trace_id = photo_to_trace.get(p["photo_id"])
    langfuse.create_score(trace_id=trace_id, name="correctness", value=correct)
```

That join is real work, and it is fragile: it needs `photo_id` in metadata, it
needs pagination, and it needs a backfill path for traces created before the
column existed. The original repo has a script for exactly that.

In Braintrust the scorer runs as part of the experiment and the association is
structural:

```python
def citation_grounding(output, **_):
    return Score(name="citation_grounding", score=..., metadata={...})
```

**When you still need the Langfuse pattern:** scoring *production* traces, where
there was no experiment. Braintrust's answer is online scoring — configure a
scorer to sample a percentage of live logs — which is the same idea without the
join.

### Experiments are the primitive, not a report

This is the part that does not map. In Braintrust, `Eval()` produces a named
experiment, and comparison against a baseline is built in — Braintrust picks the
base experiment from git history automatically, and every scorer reports a
`diff` against it. That `diff` is what makes a per-scorer regression gate
possible at all:

```ts
if (gate.maxRegression !== undefined && score.diff !== undefined) {
  if (-score.diff > gate.maxRegression) { /* fail the build */ }
}
```

Reproducing this on Langfuse means running your own comparison and your own
history — doable, but you are building the thing rather than using it.

### CI is a supported path

`bt eval --no-input --json` plus `braintrustdata/eval-action@v2` gives you eval
results as a PR comment and a non-zero exit on failure. The Langfuse project ran
its eval loop by hand, on a laptop, after the fact.

---

## What I would tell a team evaluating both

**Stay on Langfuse if** tracing and cost visibility are the actual need, you are
self-hosting and want a smaller surface to run, or your team's evaluation is
mostly human review of production traces. Langfuse is a clean, focused tracing
product and the OSS story is genuinely strong.

**Move to Braintrust if** you are shipping changes to an LLM system regularly
and cannot currently answer *"did this make it better?"* before merging.
Concretely, the tell is: someone changed a prompt last month, everyone agreed it
felt better, and nobody can produce a number.

**The migration itself is small.** Instrumentation is a mechanical
find-and-replace. The real work is not porting code — it is **building the
golden dataset**, which most teams do not have yet, and which is the actual
prerequisite for either platform's eval story. In this repo that is
[`evals/build_golden.ts`](../evals/build_golden.ts): 44 cases derived from
ground truth and verified solvable at build time. That file took longer to get
right than the instrumentation did.
