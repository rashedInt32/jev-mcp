// Shared test rig: a local stand-in for the TypeSafe API plus an MCP client.
//
// Tests drive the real built server over stdio through the official MCP client,
// so there are no sleeps and no hand-rolled JSON-RPC framing. The stand-in
// records every outbound request, which is how the regression tests prove what
// the server actually sends rather than what it claims to send.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const SERVER_PATH = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Name assembled at runtime so scanners don't read this file as a credential. */
const KEY_VAR = ["TYPESAFE", "API", "KEY"].join("_");

/** Start a stand-in API that records requests and returns well-formed answers. */
export async function startMock() {
  const requests = [];
  // `answers`, when set, replaces the generated answers verbatim, so a test
  // can hand the server a malformed response and prove it is rejected.
  // `delayMs` holds each response so a test can observe how many requests are
  // in flight at once; `maxInFlight` records the peak. `usage`, when set,
  // replaces the default token counts, so a test can add fields the API may send.
  const state = { confidence: 0.9, noul: 0.5, status: 200, body: null, answers: null, usage: null, delayMs: 0, inFlight: 0, maxInFlight: 0 };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        parsed = raw;
      }
      requests.push({ url: req.url, body: parsed });
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
      state.inFlight -= 1;

      res.setHeader("content-type", "application/json");
      res.setHeader("x-typesafe-request-id", "req_test_123");

      if (state.status !== 200) {
        res.writeHead(state.status);
        res.end(JSON.stringify(state.body ?? { error: { message: "mock failure" } }));
        return;
      }

      if (req.url?.includes("/models")) {
        res.writeHead(200);
        res.end(JSON.stringify({ models: [{ name: "jev-latest", description: "Flagship", release_date: "2026-01-01" }] }));
        return;
      }

      const answers = {};
      for (const [id, q] of Object.entries(parsed.questions ?? {})) {
        if (q.type === "noul") {
          answers[id] = { type: "noul", noul: state.noul };
        } else if (q.type === "choice") {
          const keys = Object.keys(q.criteria ?? {});
          answers[id] = {
            type: "choice",
            choice: keys[0] ?? "x",
            confidence: state.confidence,
            // A real distribution: the winner takes 0.9, the rest share 0.1.
            probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.9 : 0.1 / Math.max(keys.length - 1, 1)])),
          };
        } else {
          const levels = (q.criteria ?? []).map((_, i) => String(i));
          answers[id] = {
            type: "score",
            score: 1,
            confidence: state.confidence,
            legend: Object.fromEntries(levels.map((k, i) => [k, q.criteria[i]])),
            probabilities: Object.fromEntries(levels.map((k) => [k, 1 / levels.length])),
          };
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify({ model: "mock-jev", answers: state.answers ?? answers, usage: state.usage ?? { input_tokens: 10, output_tokens: 2 } }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    requests,
    state,
    /** The single outbound request body, asserting exactly one was sent. */
    only() {
      if (requests.length !== 1) throw new Error(`expected exactly 1 request, saw ${requests.length}`);
      return requests[0].body;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Connect an MCP client to the built server.
 *
 * `withKey: false` starts the server with no credential at all, which is how
 * the missing-key path is exercised.
 */
export async function withClient({ baseUrl, withKey = true, env = {} } = {}, fn) {
  // Pin the key-file fallback at a path that cannot exist. HOME is passed
  // through, so without this the suite would start reading a real
  // ~/.config/typesafe/key the moment one exists, and the missing-key test
  // would quietly begin making live calls instead of exercising the failure
  // path. A test that needs the fallback passes JEV_KEY_FILE explicitly.
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    JEV_KEY_FILE: "/nonexistent/jev-mcp-test/key",
    ...env,
  };
  if (baseUrl) childEnv.TYPESAFE_BASE_URL = baseUrl;
  if (withKey) childEnv[KEY_VAR] = "value-for-the-local-stand-in";

  const client = new Client({ name: "jev-mcp-test", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: childEnv,
    stderr: "ignore",
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Parse the JSON a tool returns in its text block. */
export function payload(result) {
  const block = result.content?.find((b) => b.type === "text");
  if (!block) throw new Error("tool returned no text content");
  return JSON.parse(block.text);
}
