/**
 * OpenRouter client — all LLM calls go through here.
 * Model: anthropic/claude-sonnet-4-5 via OpenRouter's OpenAI-compatible endpoint.
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MODEL = "anthropic/claude-sonnet-4-5";

/** Cheap fast model for high-frequency trigger decisions. */
export const FAST_MODEL = "anthropic/claude-haiku-4.5";

/** Default output caps — OpenRouter reserves credits against max_tokens; the
 *  model default (64k) exceeds most key limits and causes HTTP 402. */
const DEFAULT_MAX_TOKENS: Record<string, number> = {
  [MODEL]: 4096,
  [FAST_MODEL]: 512,
};

export interface ChatOptions {
  json?: boolean;
  model?: string;
  maxTokens?: number;
}

function headers(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY ?? "";
  return {
    Authorization: `Bearer ${key}`,
    "HTTP-Referer": "https://ghostwork.app",
    "X-Title": "Ghostwork",
    "Content-Type": "application/json",
  };
}

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMResult {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Send a chat completion request. Always returns JSON when json=true.
 * Wraps in try/catch — never throws; returns null on failure.
 */
export async function chat(
  messages: LLMMessage[],
  options: ChatOptions = {}
): Promise<LLMResult | null> {
  const key = process.env.OPENROUTER_API_KEY ?? "";
  if (!key) {
    console.warn("[openrouter] OPENROUTER_API_KEY not set — skipping LLM call");
    return null;
  }

  const model = options.model ?? MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS[model] ?? 4096;

  try {
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens,
    };
    if (options.json) {
      body.response_format = { type: "json_object" };
    }

    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 402) {
        console.error(
          `[openrouter] HTTP 402 — insufficient credits for max_tokens=${maxTokens}. ` +
            `Add credits at openrouter.ai or lower max_tokens. Response: ${text.slice(0, 200)}`
        );
      } else {
        console.error(`[openrouter] HTTP ${res.status}: ${text}`);
      }
      return null;
    }

    const data = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    return {
      content,
      model: data?.model ?? model,
      usage: data?.usage,
    };
  } catch (err) {
    console.error("[openrouter] Request failed:", err);
    return null;
  }
}

/** Convenience: send a single user prompt and get back parsed JSON. */
export async function promptJSON<T>(
  prompt: string,
  model: string = MODEL,
  maxTokens?: number
): Promise<T | null> {
  const result = await chat(
    [{ role: "user", content: prompt }],
    { json: true, model, maxTokens }
  );
  if (!result) return null;
  try {
    return JSON.parse(extractJSON(result.content)) as T;
  } catch {
    console.error("[openrouter] Failed to parse JSON response:", result.content);
    return null;
  }
}

function extractJSON(content: string): string {
  const trimmed = content.trim();

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject !== -1 && lastObject > firstObject) {
    return trimmed.slice(firstObject, lastObject + 1);
  }

  return trimmed;
}

/** Send a test prompt to confirm the API key and endpoint work. */
export async function testConnection(): Promise<boolean> {
  console.log("[openrouter] Sending test prompt …");
  const result = await chat(
    [
      {
        role: "user",
        content:
          'Reply with exactly this JSON and nothing else: {"status":"ok","app":"ghostwork"}',
      },
    ],
    { json: true, maxTokens: 128 }
  );
  if (!result) {
    console.warn("[openrouter] Test failed — no response");
    return false;
  }
  console.log("[openrouter] Test response:", result.content);
  console.log("[openrouter] Model:", result.model, "| Tokens:", result.usage);
  return true;
}
