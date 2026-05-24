// app/api/agent/ingest/route.ts — ADR-0010 step 3a.
//
// SSE-based admin-only ingestion agent route. Runs one assistant turn per
// HTTP POST; the turn may internally loop through several tool-use round
// trips. The route is the loop driver — it calls the AgentClient,
// materializes tool_use events, dispatches tools locally, builds the next
// `messages[]`, and re-calls the agent until `stop_reason !== "tool_use"`.
//
// This file ONLY targets the stub AgentClient — real Anthropic adapter is
// deferred to ADR-0010 step 3b. The `getAgent()` factory will throw
// `RangeError` when AGENT_PROVIDER=anthropic until that step lands; the
// route bubbles that throw as a 500 (config error, not transient outage).
//
// ADR-0010 contract mapping:
//   §1 (transport)   → SSE bytes: `data: ${JSON.stringify(AgentEvent)}\n\n`
//                       + `: keepalive\n\n` comment lines on idle.
//                       Headers: text/event-stream + no-cache + no-transform
//                       + X-Accel-Buffering: no.
//   §2 (mechanical)  → submit_entry dispatch calls submitEntryFromAgent
//                       (never createEntry directly). Source-file-no-import
//                       test in route.test.ts is the mechanical floor.
//   §3 (caps)        → AGENT_MAX_TOOL_ITERATIONS=8, AGENT_REQUEST_DEADLINE_MS=60000,
//                       AGENT_MAX_TURNS=20 (messages.length>40 → 400 pre-stream),
//                       AGENT_KEEPALIVE_MS=10000.
//   §4 (state)       → ephemeral; client sends full message history each turn.
//                       Abort honored via req.signal → composed signal → agent.
//   §6 (tools)       → AGENT_TOOLS registry; dispatch branches on name.
//   §7 (degraded)    → AgentUnavailableError → 503 {error:"agent_unavailable"}.
//   §8 (iron rules)  → #4 withAdmin, #2 via submitEntryFromAgent, #10 via
//                       prompt-hash, #12 via 503, #6/#7 via IngestBody.safeParse.
//
// Runtime: pinned to Node — lib/log.ts uses process.stdout; lib/prompts.ts
// uses readFileSync; lib/db.ts uses pg.Pool. Edge runtime would silently
// break all three. No explicit Transfer-Encoding is set; Node manages
// `Transfer-Encoding: chunked` automatically for the streamed Response.

import { type NextRequest } from "next/server";
import { z } from "zod";

import * as schema from "@/drizzle/schema";
import {
  type AgentClient,
  type AgentContentBlock,
  type AgentEvent,
  type AgentMessage,
  AgentUnavailableError,
  getAgent,
} from "@/lib/agents";
import { AGENT_TOOLS } from "@/lib/agents-tools";
import { withAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEmbedder } from "@/lib/embedding";
import { EmptyBodyAfterScrubError, submitEntryFromAgent } from "@/lib/ingest";
import { IngestBody, issuesFromZodError } from "@/lib/ingest-schema";
import { logEvent } from "@/lib/log";
import { INGESTION_AGENT_PROMPT, INGESTION_AGENT_PROMPT_HASH } from "@/lib/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Env-driven caps (ADR-0010 §3) ──────────────────────────────────────────

type AgentEnvConfig = {
  maxToolIterations: number;
  deadlineMs: number;
  maxTurns: number;
  keepaliveMs: number;
};

function readEnvConfig(): AgentEnvConfig {
  const cfg: AgentEnvConfig = {
    maxToolIterations: readPositiveInt("AGENT_MAX_TOOL_ITERATIONS", 8),
    deadlineMs: readPositiveInt("AGENT_REQUEST_DEADLINE_MS", 60_000),
    maxTurns: readPositiveInt("AGENT_MAX_TURNS", 20),
    keepaliveMs: readPositiveInt("AGENT_KEEPALIVE_MS", 10_000),
  };
  return cfg;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${raw}`);
  }
  return n;
}

// ── Request body schema ────────────────────────────────────────────────────

// Permissive validation: the route trusts admin-issued message structure
// (withAdmin gates the call). The agent SDK and IngestBody enforce
// stricter shape downstream. This boundary just guarantees we have an
// iterable `messages[]` whose shape is plausible.
const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.string(),
    is_error: z.boolean().optional(),
  }),
]);

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});

const BodySchema = z.object({
  messages: z.array(MessageSchema),
});

// ── Tool dispatch ──────────────────────────────────────────────────────────

type ToolDispatchResult = { ok: true; output: unknown } | { ok: false; error: string };

/**
 * Run one tool by name. The driver passes `tool_use_start.input` verbatim
 * from the agent; this function is responsible for schema validation
 * (for submit_entry), DB calls (list_categories), and stubbed returns
 * (search_kb). Generic throws are mapped to `ok:false` so the loop can
 * continue and let the agent re-prompt; only the dispatcher decides
 * what's recoverable.
 */
async function dispatchTool(name: string, input: unknown): Promise<ToolDispatchResult> {
  try {
    switch (name) {
      case "submit_entry":
        return await dispatchSubmitEntry(input);
      case "list_categories":
        return await dispatchListCategories();
      case "search_kb":
        // M3-deferred stub per ADR-0010 §6.
        return {
          ok: true,
          output: { candidates: [], note: "retrieval_unavailable_m2a" },
        };
      default:
        return { ok: false, error: `unknown_tool:${name}` };
    }
  } catch (err) {
    // Non-Zod, non-EmptyBody throws → log + recover. The agent gets a
    // failed tool_result and can decide what to do; the stream stays open.
    logEvent({
      kind: "route",
      route: "POST /api/agent/ingest",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "tool_dispatch_failed" };
  }
}

async function dispatchSubmitEntry(input: unknown): Promise<ToolDispatchResult> {
  const parsed = IngestBody.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: JSON.stringify({
        code: "invalid_input",
        issues: issuesFromZodError(parsed.error),
      }),
    };
  }
  try {
    const created = await submitEntryFromAgent({
      db: getDb(),
      embedder: getEmbedder(),
      input: parsed.data,
    });
    return { ok: true, output: created };
  } catch (err) {
    if (err instanceof EmptyBodyAfterScrubError) {
      return {
        ok: false,
        error: JSON.stringify({
          code: "empty_after_scrub",
          issues: [{ path: "body", code: "empty_after_scrub" }],
        }),
      };
    }
    throw err;
  }
}

async function dispatchListCategories(): Promise<ToolDispatchResult> {
  const db = getDb();
  const rows = await db
    .selectDistinct({ category: schema.entries.category })
    .from(schema.entries)
    .orderBy(schema.entries.category);
  return { ok: true, output: { categories: rows.map((r) => r.category) } };
}

// ── Tool-use loop driver ───────────────────────────────────────────────────

type DriverStats = { iterations: number };

/**
 * The per-request tool-use loop. Streams AgentEvents to the consumer
 * (the SSE writer). On each iteration: calls the agent, accumulates
 * text + tool_use blocks in order, executes tools, appends an assistant
 * + user pair to the running `messages[]`, loops until done.
 *
 * `stats.iterations` is mutated to expose the final round-trip count
 * to the caller for `LogEventClaude.tool_iterations` after the
 * generator returns.
 */
async function* runAgentTurn(
  agent: AgentClient,
  initialMessages: AgentMessage[],
  signal: AbortSignal,
  env: AgentEnvConfig,
  stats: DriverStats,
): AsyncGenerator<AgentEvent, void, void> {
  let messages: AgentMessage[] = [...initialMessages];

  while (true) {
    if (stats.iterations >= env.maxToolIterations) {
      yield { kind: "done", stop_reason: "max_iterations" };
      return;
    }

    const events = agent.streamMessages({
      system_prompt: INGESTION_AGENT_PROMPT,
      messages,
      tools: AGENT_TOOLS,
      max_tool_iterations: env.maxToolIterations,
      deadline_ms: env.deadlineMs,
      signal,
    });

    // Ordered reconstruction of assistant content. text_delta extends the
    // trailing text block (or opens a new one if the last block is a
    // tool_use); tool_use_start always flushes the pending text block
    // first and pushes a fresh tool_use block. This preserves Anthropic's
    // [text, tool_use, text, tool_use, ...] interleaving — lumping all
    // text into one accumulator would break multi-text turns.
    const assistantBlocks: AgentContentBlock[] = [];
    let pendingText = "";
    const flushText = () => {
      if (pendingText.length > 0) {
        assistantBlocks.push({ type: "text", text: pendingText });
        pendingText = "";
      }
    };
    const collectedToolUses: Array<{ id: string; name: string; input: unknown }> = [];
    let lastDone: (AgentEvent & { kind: "done" }) | null = null;
    let sawError = false;

    for await (const ev of events) {
      yield ev;
      switch (ev.kind) {
        case "text_delta":
          pendingText += ev.text;
          break;
        case "tool_use_start":
          flushText();
          assistantBlocks.push({
            type: "tool_use",
            id: ev.id,
            name: ev.name,
            input: ev.input,
          });
          collectedToolUses.push({ id: ev.id, name: ev.name, input: ev.input });
          break;
        case "done":
          flushText();
          lastDone = ev;
          break;
        case "error":
          sawError = true;
          break;
        case "tool_result":
          // Tool results in the stream from the agent itself would mean
          // the SDK is replaying a prior turn's tool output — out of scope
          // for M2a. Ignore.
          break;
      }
    }

    if (sawError || !lastDone) return;
    if (lastDone.stop_reason !== "tool_use") return;

    // Dispatch each collected tool_use, emit tool_result events, and build
    // the next-turn user message containing tool_result content blocks.
    const toolResultBlocks: AgentContentBlock[] = [];
    for (const tu of collectedToolUses) {
      const result = await dispatchTool(tu.name, tu.input);
      const resultEvent: AgentEvent =
        result.ok === true
          ? { kind: "tool_result", name: tu.name, ok: true, output: result.output }
          : { kind: "tool_result", name: tu.name, ok: false, error: result.error };
      yield resultEvent;
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result.ok ? result.output : { error: result.error }),
        is_error: !result.ok,
      });
    }

    messages = [
      ...messages,
      { role: "assistant", content: assistantBlocks },
      { role: "user", content: toolResultBlocks },
    ];
    stats.iterations += 1;
  }
}

// ── HTTP handler ───────────────────────────────────────────────────────────

function jsonError(status: number, error: string, extra?: object): Response {
  return new Response(JSON.stringify({ error, ...(extra ?? {}) }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handler(req: NextRequest): Promise<Response> {
  // 1. Body parse + Zod validate.
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return jsonError(400, "invalid_request", {
      issues: [{ path: "", code: "invalid_json" }],
    });
  }
  const bodyResult = BodySchema.safeParse(parsed);
  if (!bodyResult.success) {
    return jsonError(400, "invalid_request", {
      issues: issuesFromZodError(bodyResult.error),
    });
  }

  // 2. Read env caps (throws RangeError on misconfig — surfaces as 500).
  const env = readEnvConfig();

  // 3. Pre-stream cap: fail fast with HTTP 400, never open the SSE.
  // ADR-0010 §3: "rejects requests whose messages.length > 40".
  if (bodyResult.data.messages.length > env.maxTurns * 2) {
    return jsonError(400, "max_turns_exceeded");
  }

  // 4. Resolve agent. AgentUnavailableError → 503 (degraded mode, #12).
  // RangeError (misconfig: missing key, unknown provider, step-3b not-wired)
  // bubbles to a 500 — config errors must not be silently degraded.
  let agent: AgentClient;
  try {
    agent = getAgent();
  } catch (err) {
    if (err instanceof AgentUnavailableError) {
      return jsonError(503, "agent_unavailable");
    }
    throw err;
  }

  // 5. Compose abort: client disconnect (req.signal) OR deadline timeout.
  // AbortSignal.any (Node ≥20.3) propagates the first abort's reason and
  // handles listener cleanup; AbortSignal.timeout schedules the
  // self-aborting timer + clears it on GC.
  const deadlineSignal = AbortSignal.timeout(env.deadlineMs);
  const composedSignal = AbortSignal.any([req.signal, deadlineSignal]);

  // 6. Build the SSE response stream.
  const messages = bodyResult.data.messages as AgentMessage[];
  const enc = new TextEncoder();
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const tryEnqueue = (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk);
        } catch {
          // Stream already closed (consumer aborted between checks).
        }
      };

      keepaliveTimer = setInterval(
        () => tryEnqueue(enc.encode(": keepalive\n\n")),
        env.keepaliveMs,
      );

      const t0 = Date.now();
      const stats: DriverStats = { iterations: 0 };
      let status: "ok" | "error" = "ok";
      let logError: string | undefined;
      // Captured for the per-turn LogEventClaude `stop_reason` field. Updated
      // on every `done` event yielded by the loop driver so the finally
      // block sees the last terminal — ADR-0010 §1 Amendment 2026-05-28 +
      // ADR-0005 Amendment 2026-05-28. Stays undefined if the stream throws
      // before any `done` lands.
      let lastStopReason: (AgentEvent & { kind: "done" })["stop_reason"] | undefined;

      try {
        for await (const ev of runAgentTurn(agent, messages, composedSignal, env, stats)) {
          tryEnqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          if (ev.kind === "error") {
            status = "error";
            logError = `${ev.code}: ${ev.message}`;
          } else if (ev.kind === "done") {
            lastStopReason = ev.stop_reason;
          }
        }
      } catch (err) {
        status = "error";
        logError = err instanceof Error ? err.message : String(err);
        const errCode = deadlineSignal.aborted
          ? "deadline_exceeded"
          : req.signal.aborted
            ? "aborted"
            : "internal";
        const errEv: AgentEvent = {
          kind: "error",
          code: errCode,
          message: errCode === "internal" ? "internal" : errCode.replace("_", " "),
        };
        tryEnqueue(enc.encode(`data: ${JSON.stringify(errEv)}\n\n`));
      } finally {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        // Per-turn LogEvent fires on every exit path — happy, error, abort.
        // ADR-0005 invariant: every Claude call logs once.
        logEvent({
          kind: "claude",
          model: agent.model,
          model_version: agent.model_version,
          prompt_hash: INGESTION_AGENT_PROMPT_HASH,
          streaming: true,
          tool_iterations: stats.iterations,
          ...(lastStopReason !== undefined ? { stop_reason: lastStopReason } : {}),
          latency_ms: Date.now() - t0,
          cost_usd: null,
          ...(status === "error"
            ? { status: "error" as const, error: logError ?? "unknown" }
            : { status: "ok" as const }),
        });
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
    cancel() {
      // Defensive: `start.finally` already clears the timer, but if the
      // consumer cancels before `start` returns and before any keepalive
      // tick has run, clearing here avoids the gap.
      if (keepaliveTimer) clearInterval(keepaliveTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export const POST = withAdmin(handler);
