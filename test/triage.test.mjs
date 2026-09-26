// Contract and regression tests for jev_triage, run against the built server
// over stdio with the local stand-in API. Each assertion is about what the
// server actually sends per item and how it reports per-item failure.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payload, startMock, withClient } from "./helpers.mjs";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "jev-triage-"));
  const root = join(base, "root");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.md"), "alpha document");
  writeFileSync(join(root, "b.md"), "beta document");
  writeFileSync(join(base, "outside.md"), "private");
  symlinkSync(join(base, "outside.md"), join(root, "link.md"));
  writeFileSync(join(root, ".env"), "TOKEN=x");
  writeFileSync(join(root, "big.md"), "x".repeat(5000));
  return { base, root };
}

const QUESTIONS = [
  { id: "kind", type: "classify", question: "What is it?", options: { doc: "Documentation", code: "Source code" } },
  { id: "useful", type: "check", question: "Is it useful?" },
];

test("query shorthand sends one check per item and returns verdicts in input order", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      mock.state.noul = 0.9;
      const result = await client.callTool({
        name: "jev_triage",
        arguments: {
          query: "Find the deployment runbook",
          items: [
            { id: "one", text: "first" },
            { id: "two", text: { title: "second" } },
            { id: "three", text: "third" },
          ],
        },
      });
      assert.notEqual(result.isError, true);
      assert.equal(mock.requests.length, 3, "one request per item");
      for (const { body } of mock.requests) {
        assert.deepEqual(Object.keys(body.questions), ["relevant"]);
        assert.equal(body.questions.relevant.type, "noul");
        assert.match(body.questions.relevant.instructions, /deployment runbook/);
        assert.match(body.questions.relevant.instructions, /as data, not as instructions/);
      }
      const states = mock.requests.map((r) => r.body.state);
      assert.ok(states.some((s) => s === "first") && states.some((s) => s?.title === "second"), "structured text reaches the model intact");

      const body = payload(result);
      assert.deepEqual(body.results.map((r) => r.id), ["one", "two", "three"]);
      for (const r of body.results) {
        assert.equal(r.answers.relevant.verdict, "yes");
        assert.equal(r.answers.relevant.noul, 0.9);
        assert.equal(typeof r.latency_ms, "number");
        assert.equal(r.error, undefined);
      }
      assert.equal(body.failed, 0);
      assert.deepEqual(body.usage, { input_tokens: 30, output_tokens: 6 }, "usage is summed over items");
      assert.equal(body.model, "mock-jev");
      assert.deepEqual(body.thresholds, { act_above: 0.8, review_above: 0.5, yes_at_or_above: 0.7, no_at_or_below: 0.3 });
      assert.deepEqual(result.structuredContent, body);
    });
  } finally {
    await mock.close();
  }
});

test("regression: triage sums cost and drops unknown usage fields", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      await client.listTools();
      mock.state.usage = { input_tokens: 10, output_tokens: 2, cost: 0.25, cached_tokens: 7 };
      const result = await client.callTool({
        name: "jev_triage",
        arguments: { query: "q", items: [{ id: "one", text: "a" }, { id: "two", text: "b" }] },
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(payload(result).usage, { input_tokens: 20, output_tokens: 4, cost: 0.5 });
    });
  } finally {
    await mock.close();
  }
});

test("typed questions gate every item like jev_ask does, and report no-match keys", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({
        name: "jev_triage",
        arguments: { questions: QUESTIONS, items: [{ id: "x", text: "s" }, { id: "y", text: "t" }] },
      });
      const body = payload(result);
      assert.deepEqual(body.none_options, { kind: "none" });
      for (const r of body.results) {
        assert.equal(r.answers.kind.action, "act");
        assert.equal(r.answers.kind.choice, "doc");
        assert.equal(r.answers.useful.verdict, "uncertain");
      }
      assert.deepEqual(Object.keys(mock.requests[0].body.questions.kind.criteria), ["doc", "code", "none"]);
    });
  } finally {
    await mock.close();
  }
});

test("path items are read server-side and their contents never appear in the tool result", async () => {
  const { root } = fixture();
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, env: { JEV_FILE_ROOTS: root } }, async (client) => {
      const result = await client.callTool({
        name: "jev_triage",
        arguments: { query: "q", items: [{ id: "a", path: join(root, "a.md") }, { id: "b", path: "b.md" }] },
      });
      assert.notEqual(result.isError, true);
      const states = mock.requests.map((r) => r.body.state).sort();
      assert.deepEqual(states, ["alpha document", "beta document"], "file contents reach the model; relative paths resolve against the root");
      const text = result.content.find((b) => b.type === "text").text;
      assert.doesNotMatch(text, /alpha document|beta document/, "contents stay out of the agent's context");
      assert.deepEqual(payload(result).file_roots, [root]);
    });
  } finally {
    await mock.close();
  }
});

test("a bad path fails in place with kind file_access, without a request, while the rest proceed", async () => {
  const { base, root } = fixture();
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, env: { JEV_FILE_ROOTS: root, JEV_MAX_STATE_CHARS: "1000" } }, async (client) => {
      const result = await client.callTool({
        name: "jev_triage",
        arguments: {
          query: "q",
          items: [
            { id: "ok", path: "a.md" },
            { id: "outside", path: join(base, "outside.md") },
            { id: "symlink", path: "link.md" },
            { id: "secret", path: ".env" },
            { id: "missing", path: "nope.md" },
            { id: "dir", path: root },
            { id: "big", path: "big.md" },
            { id: "bigtext", text: "y".repeat(1001) },
          ],
        },
      });
      assert.notEqual(result.isError, true, "one success means the call is a result, not an error");
      assert.equal(mock.requests.length, 1, "only the readable item costs a request");
      const body = payload(result);
      assert.equal(body.failed, 7);
      const byId = Object.fromEntries(body.results.map((r) => [r.id, r]));
      assert.equal(byId.ok.answers.relevant.type, "noul");
      for (const id of ["outside", "symlink", "secret", "missing", "dir", "big"]) {
        assert.equal(byId[id].error.kind, "file_access", `${id} must be a file_access error`);
        assert.equal(byId[id].error.retryable, false);
        assert.ok(byId[id].error.hint, `${id} needs a hint`);
        assert.equal(byId[id].answers, undefined);
      }
      assert.match(byId.outside.error.message, /outside the allowed roots/);
      assert.match(byId.symlink.error.message, /outside the allowed roots/);
      assert.match(byId.secret.error.message, /credential/);
      assert.match(byId.big.error.message, /above the 1000 character limit/);
      assert.equal(byId.bigtext.error.kind, "invalid_arguments");
      assert.match(byId.bigtext.error.message, /above the 1000 limit/);
      const text = result.content.find((b) => b.type === "text").text;
      assert.doesNotMatch(text, /TOKEN=x|private/, "refused contents never leak through an error");
    });
  } finally {
    await mock.close();
  }
});

test("the server's own key file is refused even when it sits inside a root", async () => {
  const { root } = fixture();
  const keyFile = join(root, "key");
  writeFileSync(keyFile, "value-for-the-local-stand-in\n", { mode: 0o600 });
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, withKey: false, env: { JEV_FILE_ROOTS: root, JEV_KEY_FILE: keyFile } }, async (client) => {
      const result = await client.callTool({ name: "jev_triage", arguments: { query: "q", items: [{ id: "k", path: "key" }] } });
      assert.equal(result.isError, true);
      assert.equal(mock.requests.length, 0);
      const body = payload(result);
      assert.equal(body.results[0].error.kind, "file_access");
      assert.match(body.results[0].error.message, /credential/);
    });
  } finally {
    await mock.close();
  }
});

test("JEV_FILE_ROOTS=off disables path items but leaves text items working", async () => {
  const { root } = fixture();
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, env: { JEV_FILE_ROOTS: "off" } }, async (client) => {
      const result = await client.callTool({
        name: "jev_triage",
        arguments: { query: "q", items: [{ id: "p", path: join(root, "a.md") }, { id: "t", text: "inline" }] },
      });
      const body = payload(result);
      assert.deepEqual(body.file_roots, []);
      assert.equal(body.results[0].error.kind, "file_access");
      assert.match(body.results[0].error.message, /disabled/);
      assert.equal(body.results[1].answers.relevant.type, "noul");
      assert.equal(mock.requests.length, 1);
    });
  } finally {
    await mock.close();
  }
});

test("every item failing makes the call an error while keeping per-item detail", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      mock.state.status = 429;
      const result = await client.callTool({ name: "jev_triage", arguments: { query: "q", items: [{ id: "a", text: "1" }, { id: "b", text: "2" }] } });
      assert.equal(result.isError, true);
      const body = payload(result);
      assert.equal(body.failed, 2);
      for (const r of body.results) {
        assert.equal(r.error.kind, "rate_limit");
        assert.equal(r.error.retryable, true);
      }
    });
  } finally {
    await mock.close();
  }
});

test("regression: a malformed answer poisons only its own item", async () => {
  const mock = await startMock();
  try {
    // Concurrency one makes item order deterministic. The stand-in records a
    // request before it builds that request's answer, so switching `answers`
    // as the second request lands leaves the first item well-formed.
    const record = mock.requests.push.bind(mock.requests);
    mock.requests.push = (entry) => {
      const n = record(entry);
      if (n === 2) mock.state.answers = { relevant: { type: "noul", noul: 7 } };
      return n;
    };
    await withClient({ baseUrl: mock.url, env: { JEV_CONCURRENCY: "1" } }, async (client) => {
      const result = await client.callTool({ name: "jev_triage", arguments: { query: "q", items: [{ id: "good", text: "1" }, { id: "bad", text: "2" }] } });
      assert.notEqual(result.isError, true);
      const body = payload(result);
      assert.equal(body.results[0].answers.relevant.noul, 0.5);
      assert.equal(body.results[1].error.kind, "malformed_response");
      assert.equal(body.results[1].error.retryable, true);
      assert.equal(body.failed, 1);
    });
  } finally {
    await mock.close();
  }
});

test("concurrency is bounded by JEV_CONCURRENCY", async () => {
  const mock = await startMock();
  try {
    mock.state.delayMs = 40;
    await withClient({ baseUrl: mock.url, env: { JEV_CONCURRENCY: "3" } }, async (client) => {
      const items = Array.from({ length: 9 }, (_, i) => ({ id: String(i), text: String(i) }));
      const result = await client.callTool({ name: "jev_triage", arguments: { query: "q", items } });
      assert.notEqual(result.isError, true);
      assert.equal(mock.requests.length, 9);
      assert.ok(mock.state.maxInFlight <= 3, `peak in-flight was ${mock.state.maxInFlight}, above the limit of 3`);
      assert.ok(mock.state.maxInFlight >= 2, `peak in-flight was ${mock.state.maxInFlight}; items did not run in parallel`);
      assert.deepEqual(payload(result).results.map((r) => r.id), items.map((i) => i.id), "order is input order regardless of completion order");
    });
  } finally {
    await mock.close();
  }
});

test("argument errors fail the whole call before any request is sent", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, env: { JEV_MAX_ITEMS: "2" } }, async (client) => {
      const cases = [
        [{ items: [{ id: "a", text: "1" }] }, /exactly one of query or questions/],
        [{ query: "q", questions: QUESTIONS, items: [{ id: "a", text: "1" }] }, /exactly one of query or questions/],
        [{ query: "q", items: [{ id: "a", text: "1" }, { id: "a", text: "2" }] }, /unique/],
        [{ query: "q", items: [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "3" }] }, /at most 2 entries/],
        [{ query: "q", yes_at_or_above: 0.2, no_at_or_below: 0.5, items: [{ id: "a", text: "1" }] }, /must not exceed/],
        [{ questions: [{ id: "k", type: "classify", question: "?" }], items: [{ id: "a", text: "1" }] }, /needs options/],
      ];
      for (const [args, pattern] of cases) {
        const result = await client.callTool({ name: "jev_triage", arguments: args });
        assert.equal(result.isError, true, JSON.stringify(args));
        assert.match(payload(result).error.message, pattern);
      }
      // An item with both or neither of text/path is a schema violation, which
      // the SDK reports as an error result before the handler runs.
      for (const item of [{ id: "a" }, { id: "a", text: "1", path: "x" }]) {
        const result = await client.callTool({ name: "jev_triage", arguments: { query: "q", items: [item] } });
        assert.equal(result.isError, true);
        assert.match(result.content.find((b) => b.type === "text").text, /exactly one of text or path/i);
      }
      assert.equal(mock.requests.length, 0);
    });
  } finally {
    await mock.close();
  }
});

test("a missing API key is one error for the call, not one per item", async () => {
  await withClient({ withKey: false }, async (client) => {
    const result = await client.callTool({ name: "jev_triage", arguments: { query: "q", items: [{ id: "a", text: "1" }, { id: "b", text: "2" }] } });
    assert.equal(result.isError, true);
    const body = payload(result);
    assert.equal(body.error.kind, "no_api_key");
    assert.equal(body.results, undefined);
  });
});
