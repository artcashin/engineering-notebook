import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  complete,
  completeWithModel,
  providerModel,
  resolveProvider,
  resetReachabilityCache,
  type SummaryProvider,
} from "./llm";

type Captured = { path: string; auth: string | null; body: any };

describe("complete (openai-compatible provider)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let captured: Captured | null;
  let reply: any;
  let status: number;

  beforeEach(() => {
    captured = null;
    status = 200;
    reply = {
      choices: [{ message: { content: "HEADLINE: did a thing" }, finish_reason: "stop" }],
    };
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        captured = {
          path: new URL(req.url).pathname,
          auth: req.headers.get("authorization"),
          body: await req.json(),
        };
        return new Response(JSON.stringify(reply), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
  });

  afterEach(() => server.stop(true));

  function provider(extra: Partial<Extract<SummaryProvider, { type: "openai" }>> = {}): SummaryProvider {
    return {
      type: "openai",
      base_url: `http://localhost:${server.port}/v1`,
      model: "gemma-4",
      ...extra,
    };
  }

  test("posts to the chat completions endpoint and returns the content", async () => {
    const text = await complete("summarize this", provider());

    expect(captured!.path).toBe("/v1/chat/completions");
    expect(captured!.body.model).toBe("gemma-4");
    expect(captured!.body.messages[0].content).toBe("summarize this");
    expect(text).toBe("HEADLINE: did a thing");
  });

  test("sends the bearer token from the configured env var", async () => {
    process.env.TEST_SPARK_KEY = "sk-test-123";
    try {
      await complete("x", provider({ api_key_env: "TEST_SPARK_KEY" }));
      expect(captured!.auth).toBe("Bearer sk-test-123");
    } finally {
      delete process.env.TEST_SPARK_KEY;
    }
  });

  test("requests a token budget large enough for a reasoning model", async () => {
    await complete("x", provider());
    // Gemma spends completion tokens on reasoning before emitting content.
    expect(captured!.body.max_tokens).toBeGreaterThanOrEqual(2000);
  });

  test("honours an explicit max_tokens", async () => {
    await complete("x", provider({ max_tokens: 8000 }));
    expect(captured!.body.max_tokens).toBe(8000);
  });

  test("fails loudly when the model returns only reasoning and no content", async () => {
    reply = { choices: [{ message: { content: "", reasoning_content: "thinking..." } }] };
    expect(complete("x", provider())).rejects.toThrow(/no content/i);
  });

  test("surfaces an HTTP error rather than returning empty text", async () => {
    status = 401;
    reply = { error: { message: "invalid api key" } };
    expect(complete("x", provider())).rejects.toThrow(/401/);
  });
});

describe("retry when the endpoint is busy", () => {
  let server: ReturnType<typeof Bun.serve>;
  let statuses: number[];
  let hits: number;

  beforeEach(() => {
    hits = 0;
    server = Bun.serve({
      port: 0,
      fetch() {
        const status = statuses[Math.min(hits, statuses.length - 1)]!;
        hits++;
        if (status !== 200) return new Response("Model busy, retry later", { status });
        return Response.json({ choices: [{ message: { content: "eventually" } }] });
      },
    });
  });

  afterEach(() => server.stop(true));

  function provider(extra: Partial<Extract<SummaryProvider, { type: "openai" }>> = {}): SummaryProvider {
    return {
      type: "openai",
      base_url: `http://localhost:${server.port}/v1`,
      model: "busy-model",
      retry_delay_ms: 1,
      ...extra,
    };
  }

  test("retries a 429 until the model answers", async () => {
    statuses = [429, 503, 200];
    expect(await complete("x", provider())).toBe("eventually");
    expect(hits).toBe(3);
  });

  test("gives up after max_retries and reports the last status", async () => {
    statuses = [429];
    await expect(complete("x", provider({ max_retries: 2 }))).rejects.toThrow(/429/);
    expect(hits).toBe(3);
  });

  test("does not retry an error that waiting cannot fix", async () => {
    statuses = [400];
    await expect(complete("x", provider())).rejects.toThrow(/400/);
    expect(hits).toBe(1);
  });
});

describe("providerModel", () => {
  test("names the configured openai model", () => {
    expect(
      providerModel({ type: "openai", base_url: "http://x/v1", model: "gemma-4" })
    ).toBe("gemma-4");
  });

  test("falls back to the built-in Claude model when unconfigured", () => {
    expect(providerModel(undefined)).toBe("claude-haiku-4-5-20251001");
  });
});

describe("fallback when the configured endpoint is off the network", () => {
  let fallbackServer: ReturnType<typeof Bun.serve>;
  let fallbackHits: string[];

  beforeEach(() => {
    resetReachabilityCache();
    fallbackHits = [];
    fallbackServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/chat/completions")) {
          fallbackHits.push(((await req.json()) as { model: string }).model);
          return Response.json({ choices: [{ message: { content: "from fallback" } }] });
        }
        return Response.json({ data: [] });
      },
    });
  });

  afterEach(() => fallbackServer.stop(true));

  /** A port nothing listens on: bind one, note it, release it. */
  function deadUrl(): string {
    const s = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = s.port;
    s.stop(true);
    return `http://127.0.0.1:${port}/v1`;
  }

  function withFallback(base_url: string): SummaryProvider {
    return {
      type: "openai",
      base_url,
      model: "local-model",
      probe_timeout_ms: 500,
      fallback: {
        type: "openai",
        base_url: `http://localhost:${fallbackServer.port}/v1/openai`,
        model: "Qwen/fallback",
      },
    };
  }

  test("uses the fallback and reports its model when the primary is down", async () => {
    const result = await completeWithModel("x", withFallback(deadUrl()));
    expect(result).toEqual({ text: "from fallback", model: "Qwen/fallback" });
    expect(fallbackHits).toEqual(["Qwen/fallback"]);
  });

  test("stays on the primary when it is reachable", async () => {
    const primary = Bun.serve({
      port: 0,
      fetch: () => Response.json({ choices: [{ message: { content: "from primary" } }] }),
    });
    try {
      const result = await completeWithModel("x", withFallback(`http://localhost:${primary.port}/v1`));
      expect(result).toEqual({ text: "from primary", model: "local-model" });
      expect(fallbackHits).toEqual([]);
    } finally {
      primary.stop(true);
    }
  });

  test("an HTTP error from a reachable primary does not trigger the fallback", async () => {
    const primary = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    try {
      expect(
        completeWithModel("x", withFallback(`http://localhost:${primary.port}/v1`))
      ).rejects.toThrow(/500/);
      expect(fallbackHits).toEqual([]);
    } finally {
      primary.stop(true);
    }
  });

  test("falls back when the primary drops off after passing its probe", async () => {
    const primary = Bun.serve({ port: 0, fetch: () => Response.json({ data: [] }) });
    const p = withFallback(`http://localhost:${primary.port}/v1`);
    expect(await resolveProvider(p)).toBe(p);
    primary.stop(true);

    const result = await completeWithModel("x", p);
    expect(result.model).toBe("Qwen/fallback");
  });

  test("without a fallback an unreachable endpoint is an error", async () => {
    expect(
      complete("x", { type: "openai", base_url: deadUrl(), model: "local-model" })
    ).rejects.toThrow(/unreachable/);
  });
});
