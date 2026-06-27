import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { CONFIG } from "./config.js";
import { hydrateSecrets } from "./secrets.js";
import { appendHistory, recentHistory, searchHistory } from "./history.js";
import { loadMemories, deleteMemory } from "./memory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });

// Secrets must be in process.env BEFORE agent.js loads (it builds the MCP servers at
// import time from the env-expanded config), so we hydrate first, then dynamic-import.
await hydrateSecrets();
const { ask } = await import("./agent.js");
const hasAuth = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN,
);

// The mobile UI is a single static file served from the repo's web/ dir.
// Read per-request so UI edits don't require a server restart.
const indexPath = join(__dirname, "../web/index.html");

app.get("/", async (_req, reply) => {
  reply.type("text/html").send(readFileSync(indexPath, "utf8"));
});

app.get("/healthz", async () => ({ ok: true, auth: hasAuth, model: CONFIG.model }));

app.post<{ Body: { question?: string; sessionId?: string } }>(
  "/ask",
  async (req, reply) => {
    const { question, sessionId } = req.body ?? {};
    if (!question || !question.trim()) {
      reply.code(400).send({ error: "question required" });
      return;
    }

    reply.hijack(); // we write the raw SSE stream ourselves
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);

    const t0 = Date.now();
    let tools = 0;
    const toolNames: string[] = [];
    let answer = "";
    let sid: string | undefined = sessionId;
    req.log.info({ q: question.slice(0, 200) }, "ask:start");
    try {
      for await (const ev of ask(question, sessionId)) {
        send(ev);
        const e = ev as { type: string; name?: string; message?: string; content?: string; sessionId?: string };
        if (e.type === "session") {
          sid = e.sessionId ?? sid;
        } else if (e.type === "text") {
          answer += e.content ?? "";
        } else if (e.type === "tool") {
          tools++;
          if (e.name) toolNames.push(e.name);
          req.log.info({ tool: e.name }, "ask:tool");
        } else if (e.type === "error") {
          req.log.error({ err: e.message, tools, ms: Date.now() - t0 }, "ask:error");
        } else if (e.type === "done") {
          req.log.info({ tools, ms: Date.now() - t0 }, "ask:done");
        }
      }
    } catch (err) {
      req.log.error({ err: (err as Error)?.message, tools, ms: Date.now() - t0 }, "ask:throw");
      send({ type: "error", message: (err as Error)?.message ?? String(err) });
    } finally {
      // Persist the Q&A (the app's own state; never touches infra) for recall + history.
      if (answer.trim()) {
        appendHistory({ ts: t0, sid, q: question, a: answer, tools: toolNames, ms: Date.now() - t0 });
      }
      res.end();
    }
  },
);

// --- Persisted history & learned memory (browse/curate from the UI) ---
app.get<{ Querystring: { q?: string; limit?: string } }>("/history", async (req) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  const q = req.query.q?.trim();
  return q ? searchHistory(q, limit) : recentHistory(limit);
});

app.get("/memory", async () => loadMemories());

app.delete<{ Params: { id: string } }>("/memory/:id", async (req, reply) => {
  const ok = deleteMemory(req.params.id);
  reply.code(ok ? 200 : 404).send({ ok });
});

if (!hasAuth) {
  app.log.warn(
    "No CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY set — agent calls will fail. Run `claude setup-token`.",
  );
}

app
  .listen({ port: CONFIG.port, host: "0.0.0.0" })
  .then(() => app.log.info(`DevOps Copilot listening on :${CONFIG.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
