"""
The same check, in the Python SDK. Runs as-is:  bt eval python/eval_appendix.py

The agent itself is TypeScript (src/agent.ts). This file exists so someone on a
Python stack can see the API shape they would write, on two example runs held
inline. It is not a second implementation of the agent — maintaining two ports
of one thing buys nothing and drifts apart silently.

    TypeScript                       Python
    ─────────────────────────────    ────────────────────────────
    wrapOpenAI(new OpenAI())         braintrust.wrap_openai(OpenAI())
    wrapTraced(fn, {type: "tool"})   @braintrust.traced(type="tool")
    Eval(project, {data, task})      Eval(project, data=..., task=...)
"""

import re

from braintrust import Eval, Score

PHOTO_ID = re.compile(r"\b\d{10,12}\b")

# Two runs of the same question, one per prompt version. The answers are
# identical; only the tool calls differ. That is the point of the whole repo.
RUNS = [
    {
        "input": {"question": "Find the photo titled 'The Pillars of Creation'. Give me its ID and date."},
        "output": {
            "answer": "Photo 52439693830, taken 2022-10-19.",
            "trajectory": [
                {"name": "search_photos", "returnedPhotoIds": ["52439693830"]},
                {"name": "get_photo", "returnedPhotoIds": ["52439693830"]},
            ],
        },
        "expected": {"tools": ["search_photos", "get_photo"]},
        "metadata": {"prompt_version": "v1-grounded"},
    },
    {
        "input": {"question": "Find the photo titled 'The Pillars of Creation'. Give me its ID and date."},
        "output": {
            "answer": "Photo 52439693830, taken 2022-10-19.",
            # Same answer, but get_photo was never called — the date is a guess.
            "trajectory": [{"name": "search_photos", "returnedPhotoIds": ["52439693830"]}],
        },
        "expected": {"tools": ["search_photos", "get_photo"]},
        "metadata": {"prompt_version": "v2-concise"},
    },
]


def citation_grounding(output, **_) -> Score:
    """Every photo ID in the answer should have come back from a tool call."""
    cited = set(PHOTO_ID.findall(output["answer"]))
    retrieved = {pid for call in output["trajectory"] for pid in call["returnedPhotoIds"]}
    if not cited:
        # Never 1.0 — an agent must not be able to win this by citing nothing.
        return Score(name="citation_grounding", score=None, metadata={"cited": 0})
    grounded = cited & retrieved
    return Score(name="citation_grounding", score=len(grounded) / len(cited), metadata={})


def tool_selection(output, expected, **_) -> Score:
    """Did it call the tools this question needs? This is what catches v2."""
    used = {call["name"] for call in output["trajectory"]}
    required = expected["tools"]
    return Score(
        name="tool_selection",
        score=len([t for t in required if t in used]) / len(required),
        metadata={"missing": [t for t in required if t not in used]},
    )


Eval(
    "JWST Research Agent",
    experiment_name="python-appendix",
    data=lambda: RUNS,
    task=lambda input: next(r["output"] for r in RUNS if r["input"] == input),
    scores=[citation_grounding, tool_selection],
    tags=["python", "appendix"],
)
