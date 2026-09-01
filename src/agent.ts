/**
 * The JWST research agent.
 *
 * A tool-calling loop over the corpus. Instrumented so that one call to
 * `runAgent` produces one Braintrust trace containing:
 *
 *   agent-turn                (function span — the whole turn)
 *   ├── chat.completions      (llm span — auto-captured by wrapOpenAI)
 *   ├── search_photos         (tool span)
 *   ├── get_photo             (tool span)
 *   ├── chat.completions      (llm span)
 *   └── ...
 *
 * The agent returns its answer alongside a structured `trajectory`. Scorers can
 * read the trajectory directly, which keeps them fast and deterministic; the
 * trace-level scorer in evals/scorers.ts reads the same information back out of
 * the span tree instead, which is what you would do when scoring production
 * logs you did not instrument yourself.
 */

import { initLogger, wrapOpenAI, wrapTraced } from "braintrust";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";

import { systemPrompt, type PromptVersion } from "./prompts.js";
import { callTool, toolSchemas } from "./tools.js";

export const DEFAULT_MODEL = process.env.AGENT_MODEL ?? "claude-haiku-4-5";
export const DEFAULT_MAX_STEPS = 8;

/**
 * Logging to Braintrust is opt-in via BRAINTRUST_API_KEY. Without it the agent
 * still runs — it just does not report — so a fresh clone can be tried out
 * before anyone signs up for anything.
 */
export const logger = process.env.BRAINTRUST_API_KEY
  ? initLogger({
      projectName: process.env.BRAINTRUST_PROJECT ?? "JWST Research Agent",
      apiKey: process.env.BRAINTRUST_API_KEY,
    })
  : undefined;

/**
 * One client for the agent and the LLM judge.
 *
 * Two ways to reach a model, chosen by which key is set:
 *
 *   Gateway (default when BRAINTRUST_GATEWAY_URL is set) — Braintrust routes to
 *   whichever provider owns the model name, using the provider key you added in
 *   its settings. Anthropic and OpenAI models are both reachable this way, in
 *   OpenAI request format, so switching providers is a model-name change and
 *   nothing else. Calls also get cost attribution for free.
 *
 *   Direct — talk to OpenAI with OPENAI_API_KEY.
 *
 * Anthropic's own SDK would need a different message format (`tool_use` and
 * `tool_result` content blocks rather than `tool_calls`), so it would mean a
 * rewrite of the loop below. The gateway avoids that.
 *
 * Built on first use, not at import. The scorer unit tests import this module
 * for its types and must keep running with no keys set; constructing an OpenAI
 * client eagerly would throw at import time and take them down with it.
 */
let client: OpenAI | undefined;

/**
 * Wrap only when nothing else already has.
 *
 * `braintrust eval` auto-instruments the OpenAI SDK before it loads the suite,
 * so calling wrapOpenAI as well logs every request twice — two sibling `llm`
 * spans with identical token counts. Scores stay correct (tool spans are
 * unaffected), but the token and cost totals on every trace come out at double
 * the truth, and wrong in the flattering direction is the worst kind of wrong.
 *
 * The runner announces itself by putting `_evals` on globalThis. Outside it
 * (`npm run agent`) nothing is instrumented, so the wrapper is still needed
 * there or the model calls would not be traced at all.
 */
function instrumented(raw: OpenAI): OpenAI {
  const runnerActive = Boolean((globalThis as { _evals?: unknown })._evals);
  return runnerActive ? raw : wrapOpenAI(raw);
}

export function modelClient(): OpenAI {
  if (!client) {
    client = instrumented(
      new OpenAI(
        process.env.BRAINTRUST_GATEWAY_URL
          ? {
              baseURL: process.env.BRAINTRUST_GATEWAY_URL,
              apiKey: process.env.BRAINTRUST_API_KEY,
            }
          : { apiKey: process.env.OPENAI_API_KEY },
      ),
    );
  }
  return client;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  /** Photo IDs this call returned, so grounding can be checked without re-running tools. */
  returnedPhotoIds: string[];
  durationMs: number;
}

export interface AgentResult {
  answer: string;
  trajectory: ToolCallRecord[];
  steps: number;
  /** True if the agent hit the step ceiling without producing a final answer. */
  truncated: boolean;
  model: string;
  promptVersion: PromptVersion;
}

export interface RunAgentOptions {
  question: string;
  promptVersion?: PromptVersion;
  model?: string;
  maxSteps?: number;
}

/** Pull every photo_id a tool result mentions, at any nesting depth. */
function extractPhotoIds(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (key === "photo_id" && typeof child === "string") found.push(child);
        else walk(child);
      }
    }
  };
  walk(value);
  return [...new Set(found)];
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A model emitting malformed tool arguments is a real failure mode worth
    // seeing in the trace rather than crashing the run.
    return { __unparseable: raw };
  }
}

async function agentTurn({
  question,
  promptVersion = "v1-grounded",
  model = DEFAULT_MODEL,
  maxSteps = DEFAULT_MAX_STEPS,
}: RunAgentOptions): Promise<AgentResult> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(promptVersion) },
    { role: "user", content: question },
  ];

  const trajectory: ToolCallRecord[] = [];
  let steps = 0;

  while (steps < maxSteps) {
    steps++;

    const completion = await modelClient().chat.completions.create({
      model,
      messages,
      tools: toolSchemas,
    });

    const message = completion.choices[0]?.message;
    if (!message) break;

    const toolCalls = (message.tool_calls ?? []) as ChatCompletionMessageToolCall[];

    if (toolCalls.length === 0) {
      return {
        answer: message.content ?? "",
        trajectory,
        steps,
        truncated: false,
        model,
        promptVersion,
      };
    }

    messages.push(message);

    for (const call of toolCalls) {
      // Only function tool calls carry a `.function` payload; guard so a
      // custom-tool response cannot throw here.
      if (call.type !== "function") continue;

      const name = call.function.name;
      const args = parseArgs(call.function.arguments);
      const startedAt = performance.now();
      const result = await callTool(name, args);
      const durationMs = Math.round(performance.now() - startedAt);

      trajectory.push({
        name,
        args,
        returnedPhotoIds: extractPhotoIds(result),
        durationMs,
      });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Out of steps. Return what we have and mark it — a run that never finished
  // should score badly on answer quality rather than be papered over.
  return { answer: "", trajectory, steps, truncated: true, model, promptVersion };
}

/**
 * The exported entry point. `wrapTraced` makes this the root span of the trace,
 * with the question as input and the full result as output.
 */
export const runAgent = wrapTraced(agentTurn, { name: "agent-turn", type: "function" });
