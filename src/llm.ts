import { setTimeout as pause } from "node:timers/promises";
import type { Extractor } from "./email.js";

function object(properties: Record<string, object>, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false };
}

const text = { type: "string" };
const flag = { type: "boolean" };
const number = { type: "number" };
const time = { type: ["string", "null"] };
const scope = object({ state: text, medication: text, dose: text }, []);
const rule = {
  anyOf: [
    object({ kind: { const: "open" }, value: flag }),
    object({ kind: { const: "stock" }, medication: text, dose: text, available: flag }),
    object({ kind: { const: "shipping" }, state: text, allowed: flag }),
    object({ kind: { enum: ["capacity", "speed"] }, value: number }),
    object({ kind: { const: "price" }, medication: text, value: number }),
    object({ kind: { const: "routing" }, action: { enum: ["prefer", "block", "clear-prefer", "clear-block"] }, scope }),
  ],
};
const proposal = object({ pharmacyId: text, from: time, until: time, windowId: text, rule }, ["pharmacyId", "rule"]);
const schema = object({
  status: { enum: ["apply", "review"] },
  changes: { type: "array", items: proposal },
  reason: text,
}, ["status"]);

class ProviderError extends Error {
  constructor(readonly status: number, readonly retryMs: number) {
    super(`Claude returned HTTP ${status}`);
  }
}

function retryable(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

function retryDelay(value: string | null): number {
  if (!value) return 250;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(250, Math.min(milliseconds, 2_000)) : 250;
}

export function claudeExtractor(env = process.env): Extractor {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("Set ANTHROPIC_API_KEY in the environment or .env.");
  const model = env.PHARMACY_LLM_MODEL?.trim() || "claude-sonnet-4-6";
  const base = env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "") || "https://api.anthropic.com/v1";

  return async (system, input) => {
    const body = JSON.stringify({
      model,
      max_tokens: 1_500,
      system,
      messages: [{ role: "user", content: input }],
      output_config: { format: { type: "json_schema", schema } },
    });
    async function send(): Promise<unknown> {
      const response = await fetch(`${base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": key!,
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(9_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderError(response.status, retryDelay(response.headers.get("retry-after")));
      }
      const data = await response.json() as {
        content?: Array<{ type?: string; text?: string }>;
        stop_reason?: string;
      };
      const content = data?.content?.find((block) => block.type === "text")?.text;
      if (!content || data.stop_reason === "max_tokens" || data.stop_reason === "refusal") {
        throw new Error("Claude did not return a complete extraction.");
      }
      return JSON.parse(content) as unknown;
    }
    try {
      return await send();
    } catch (error) {
      if (!retryable(error)) throw error;
      await pause(error instanceof ProviderError ? error.retryMs : 250);
      return send();
    }
  };
}
