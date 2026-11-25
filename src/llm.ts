/**
 * Model provider for journal summarization and session titling.
 *
 * Defaults to Claude via the Agent SDK. Any OpenAI-compatible endpoint can be
 * used instead — including a local llama.cpp server — by configuring a
 * `summary_provider` block.
 */

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";

/** Reasoning models spend completion tokens thinking before emitting content. */
const DEFAULT_MAX_TOKENS = 4000;

export type SummaryProvider =
  | { type: "anthropic"; model?: string }
  | {
      type: "openai";
      /** Endpoint root, e.g. http://host:8001/v1 */
      base_url: string;
      model: string;
      /** Name of the environment variable holding the API key. */
      api_key_env?: string;
      max_tokens?: number;
      /**
       * Provider to use when this endpoint cannot be reached on the network
       * (connection refused, DNS failure, timeout) — e.g. a hosted model that
       * stands in for a local box that is switched off. An endpoint that
       * answers, even with an HTTP error, is not treated as unreachable.
       */
      fallback?: SummaryProvider;
      /** How long to wait for the reachability probe. Defaults to 3000 ms. */
      probe_timeout_ms?: number;
    };

type OpenAIProvider = Extract<SummaryProvider, { type: "openai" }>;

const DEFAULT_PROBE_TIMEOUT_MS = 3000;
/** How long a reachability verdict is trusted before probing again. */
const PROBE_TTL_MS = 60_000;

/** The endpoint could not be contacted at all — distinct from an HTTP error. */
export class ProviderUnreachableError extends Error {}

const reachability = new Map<string, { ok: boolean; at: number }>();

/** Forget cached reachability verdicts. */
export function resetReachabilityCache(): void {
  reachability.clear();
}

function authHeaders(provider: OpenAIProvider): Record<string, string> {
  const apiKey = provider.api_key_env ? process.env[provider.api_key_env] : undefined;
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Whether the endpoint answers at all. Any HTTP response counts as reachable. */
async function isReachable(provider: OpenAIProvider): Promise<boolean> {
  const cached = reachability.get(provider.base_url);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.ok;

  let ok = true;
  try {
    const res = await fetch(`${provider.base_url.replace(/\/$/, "")}/models`, {
      headers: authHeaders(provider),
      signal: AbortSignal.timeout(provider.probe_timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel();
  } catch {
    ok = false;
  }
  reachability.set(provider.base_url, { ok, at: Date.now() });
  return ok;
}

/**
 * Pick the provider that will actually serve a request: the configured one,
 * or its fallback when the configured endpoint is off the network.
 */
export async function resolveProvider(
  provider?: SummaryProvider
): Promise<SummaryProvider | undefined> {
  let current = provider;
  while (current?.type === "openai" && current.fallback && !(await isReachable(current))) {
    current = current.fallback;
  }
  return current;
}

/** The model name to record against generated entries. */
export function providerModel(provider?: SummaryProvider): string {
  if (!provider || provider.type === "anthropic") {
    return provider?.model ?? DEFAULT_CLAUDE_MODEL;
  }
  return provider.model;
}

async function completeOpenAI(
  prompt: string,
  provider: OpenAIProvider
): Promise<string> {
  const url = `${provider.base_url.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders(provider),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: provider.max_tokens ?? DEFAULT_MAX_TOKENS,
      }),
    });
  } catch (err) {
    reachability.set(provider.base_url, { ok: false, at: Date.now() });
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProviderUnreachableError(
      `${provider.model} at ${provider.base_url} is unreachable: ${detail}`
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `${provider.model} request failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "";

  if (!text.trim()) {
    throw new Error(
      `${provider.model} returned no content (reasoning models need a larger max_tokens budget)`
    );
  }

  return text;
}

async function completeAnthropic(
  prompt: string,
  provider?: Extract<SummaryProvider, { type: "anthropic" }>
): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const result = query({
    prompt,
    options: {
      model: provider?.model ?? DEFAULT_CLAUDE_MODEL,
      maxTurns: 1,
      tools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      env,
    },
  });

  let text = "";
  for await (const message of result) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if ("text" in block && typeof block.text === "string") {
          text += block.text;
        }
      }
    }
  }

  if (!text.trim()) throw new Error("Empty response from LLM");
  return text;
}

/**
 * Send a single prompt and return the response along with the model that
 * produced it — which is the fallback's model when the configured endpoint was
 * unreachable.
 */
export async function completeWithModel(
  prompt: string,
  provider?: SummaryProvider
): Promise<{ text: string; model: string }> {
  let current = await resolveProvider(provider);
  for (;;) {
    try {
      const text =
        current?.type === "openai"
          ? await completeOpenAI(prompt, current)
          : await completeAnthropic(prompt, current);
      return { text, model: providerModel(current) };
    } catch (err) {
      // The endpoint passed its probe but dropped off before answering.
      if (err instanceof ProviderUnreachableError && current?.type === "openai" && current.fallback) {
        current = await resolveProvider(current.fallback);
        continue;
      }
      throw err;
    }
  }
}

/** Send a single prompt and return the model's text response. */
export async function complete(
  prompt: string,
  provider?: SummaryProvider
): Promise<string> {
  return (await completeWithModel(prompt, provider)).text;
}
