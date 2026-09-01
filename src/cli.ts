/**
 * Ask the agent a question from the terminal.
 *
 *   npm run agent -- "How many nebula photos are in the corpus?"
 *   npm run agent -- --prompt v2-concise "Find the Cartwheel Galaxy photo."
 *   npm run agent -- --json "What is photo 51842916663?"
 *
 * With BRAINTRUST_API_KEY set, each run produces a trace in the project's Logs.
 * That is the production surface this repo evaluates: the same code path the
 * eval exercises, so online scores and offline experiment scores describe one
 * system rather than two.
 */

import { runAgent, logger } from "./agent.js";
import { PROMPT_VERSIONS, type PromptVersion } from "./prompts.js";

interface Options {
  question: string;
  promptVersion: PromptVersion;
  model?: string;
  json: boolean;
}

function parseArgv(argv: string[]): Options {
  const rest: string[] = [];
  let promptVersion: PromptVersion = "v1-grounded";
  let model: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--prompt" || arg === "-p") {
      const value = argv[++i];
      if (!PROMPT_VERSIONS.includes(value as PromptVersion)) {
        throw new Error(`Unknown prompt version "${value}". Known: ${PROMPT_VERSIONS.join(", ")}`);
      }
      promptVersion = value as PromptVersion;
    } else if (arg === "--model" || arg === "-m") {
      model = argv[++i];
    } else if (arg === "--json") {
      json = true;
    } else {
      rest.push(arg);
    }
  }

  return { question: rest.join(" ").trim(), promptVersion, model, json };
}

async function main(): Promise<void> {
  const opts = parseArgv(process.argv.slice(2));

  if (!opts.question) {
    console.error('Usage: npm run agent -- [--prompt v1-grounded|v2-concise] [--model M] [--json] "your question"');
    process.exit(1);
  }
  // Either route is fine: the gateway (authenticated with the Braintrust key)
  // or OpenAI directly. Only complain when neither is configured.
  const viaGateway = Boolean(process.env.BRAINTRUST_GATEWAY_URL && process.env.BRAINTRUST_API_KEY);
  if (!viaGateway && !process.env.OPENAI_API_KEY) {
    console.error(
      "No model provider configured. Set BRAINTRUST_GATEWAY_URL + BRAINTRUST_API_KEY, " +
        "or OPENAI_API_KEY. See .env.example.",
    );
    process.exit(1);
  }

  const result = await runAgent({
    question: opts.question,
    promptVersion: opts.promptVersion,
    model: opts.model,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n${result.answer}\n`);
    console.log(`  prompt: ${result.promptVersion}   model: ${result.model}   steps: ${result.steps}`);
    if (result.trajectory.length === 0) {
      console.log("  tools:  (none — the agent answered without looking anything up)");
    } else {
      console.log("  tools:");
      for (const call of result.trajectory) {
        const args = JSON.stringify(call.args);
        const ids = call.returnedPhotoIds.length ? ` → ${call.returnedPhotoIds.length} id(s)` : "";
        console.log(`    ${call.name}${args === "{}" ? "" : ` ${args}`}${ids}  [${call.durationMs}ms]`);
      }
    }
    if (result.truncated) {
      console.log("  note:   hit the step ceiling before finishing.");
    }
  }

  // Without an explicit flush the process can exit before spans are sent.
  await logger?.flush();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
