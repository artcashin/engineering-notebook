import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb, closeDb } from "./db";
import { backfillTitles } from "./titles";

describe("backfillTitles", () => {
  let db: Database;
  let server: ReturnType<typeof Bun.serve>;
  let models: string[];
  let status: number;

  beforeEach(() => {
    db = initDb(":memory:");
    db.run("INSERT INTO projects (id, path, display_name) VALUES ('p', '/p', 'p')");
    for (const id of ["a", "b"]) {
      db.run(
        "INSERT INTO sessions (id, project_id, project_path, source_path, started_at, ingested_at) VALUES (?, 'p', '/p', ?, '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z')",
        [id, `/p/${id}.jsonl`]
      );
      db.run("INSERT INTO conversations (session_id, conversation_markdown, extracted_at) VALUES (?, 'fix the build', '2026-01-01T11:00:00Z')", [id]);
    }
    models = [];
    status = 200;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        models.push(((await req.json()) as { model: string }).model);
        if (status !== 200) return new Response("no such model", { status });
        return Response.json({ choices: [{ message: { content: '"Fix the build."' } }] });
      },
    });
  });

  afterEach(() => {
    server.stop(true);
    closeDb();
  });

  const provider = () => ({
    type: "openai" as const,
    base_url: `http://localhost:${server.port}/v1`,
    model: "anthropic/claude-haiku-4-5",
  });

  test("titles untitled sessions with the given provider", async () => {
    const result = await backfillTitles(db, { provider: provider() });

    expect(result.generated).toBe(2);
    expect(models).toEqual(["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5"]);
    const titles = db.query("SELECT title FROM sessions ORDER BY id").all() as { title: string }[];
    expect(titles.map((t) => t.title)).toEqual(["Fix the build", "Fix the build"]);
  });

  test("reports why a run produced nothing", async () => {
    status = 404;
    const result = await backfillTitles(db, { provider: provider() });

    expect(result).toMatchObject({ generated: 0, skipped: 2 });
    expect(result.firstError).toMatch(/404/);
  });
});
