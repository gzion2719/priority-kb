// scripts/start-test-server.ts — spawn a `next start` subprocess for e2e
// specs per ADR-0014 §2. TypeScript so vitest's e2e config can import the
// helper + types cleanly via the @/ alias, with no allowJs/checkJs
// ceremony for the spec consumer.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");

export interface StartTestServerOptions {
  /** Port to bind. Default: ephemeral (Node-allocated free port). */
  port?: number;
  /** Extra env merged into the spawned process env. Useful for stub flags. */
  env?: Record<string, string>;
  /** ms to wait for the server to respond on the base URL. Default 30000. */
  readyTimeoutMs?: number;
}

export interface TestServer {
  port: number;
  /** `http://127.0.0.1:${port}` — base URL for fetch() in specs. */
  baseUrl: string;
  /** SIGTERM the subprocess; awaits process exit. SIGKILL fallback after 5s. */
  kill: () => Promise<void>;
}

/**
 * Find a free TCP port by binding to port 0 and reading back what the OS
 * allocated, then closing the listener. Tiny race window between close
 * and the next spawn binding it, but e2e tests are the only consumer
 * and never race with each other in this project's single-threaded e2e
 * config (vitest.e2e.config.ts `fileParallelism: false`).
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr === null || typeof addr === "string") {
        s.close();
        reject(new Error("net.Server.address() returned unexpected shape"));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

/**
 * Poll a URL until it returns ANY non-network-error response, or until
 * the timeout elapses. Used to wait for `next start` to bind — we don't
 * care about the response status, only that the server accepts the
 * connection.
 */
async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      // Any HTTP response means the server is bound and responding.
      // Drain the body so the socket can close cleanly.
      void res.arrayBuffer();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "(none)");
  throw new Error(
    `start-test-server: server at ${url} did not become ready within ${timeoutMs}ms (last error: ${lastMsg})`,
  );
}

/**
 * Spawn `next start` in a subprocess. Caller is responsible for awaiting
 * `kill()` in `afterAll` — leaking the subprocess will block CI exit.
 */
export async function startTestServer(opts: StartTestServerOptions = {}): Promise<TestServer> {
  const port = opts.port ?? (await findFreePort());
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30000;
  const baseUrl = `http://127.0.0.1:${port}`;

  // `npx next start` rather than a direct node invocation so resolution
  // mirrors `npm start` in the local dev path — anything that runs in
  // CI also runs at the shell.
  const child: ChildProcess = spawn(
    "npx",
    ["next", "start", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      // shell:true on Windows so `npx` resolves via cmd.exe; harmless on POSIX.
      shell: process.platform === "win32",
    },
  );

  // Drain stdio so the subprocess doesn't block on a full pipe buffer.
  // Forward stderr lines that look like errors so CI logs are useful.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = String(chunk);
    if (/error|warn|fail/i.test(text)) {
      process.stderr.write(`[next-start] ${text}`);
    }
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  // Race ready-poll against unexpected exit so the test fails fast if
  // next start dies during boot.
  const ready = waitForReady(baseUrl, readyTimeoutMs);
  const winner = await Promise.race([
    ready.then(() => "ready" as const),
    exitPromise.then(() => "exited" as const),
  ]);
  if (winner === "exited") {
    const { code, signal } = await exitPromise;
    throw new Error(
      `start-test-server: next start exited during boot (code=${code}, signal=${signal})`,
    );
  }

  const kill: () => Promise<void> = async () => {
    if (child.exitCode !== null) return; // already exited
    child.kill("SIGTERM");
    // Give it 5s to shut down cleanly; SIGKILL after.
    const exited = await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await exitPromise;
    }
  };

  return { port, baseUrl, kill };
}
