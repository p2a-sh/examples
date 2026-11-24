import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefix = ["wh", "sec_"].join("");

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

function loadSnippet(name) {
  const source = read(path.join("workflows/snippets", name));
  const module = { exports: {} };
  // Same realm as the test, so returned objects compare with deepEqual.
  const runner = new Function("module", "exports", "require", "Buffer", source);
  runner(module, module.exports, require, Buffer);
  return module.exports;
}

function workflow(name) {
  return JSON.parse(read(path.join("workflows", name)));
}

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

function byName(doc) {
  return new Map(doc.nodes.map((node) => [node.name, node]));
}

function toolName(node) {
  const body = node.parameters?.jsonBody || "";
  const match = body.match(/"name":"([^"]+)"/);
  return match ? match[1] : "";
}

function waitSeconds(node) {
  const match = (node.parameters?.jsonBody || "").match(/wait_seconds:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function reachable(doc, start) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const port of doc.connections[name]?.main || []) {
      for (const link of port || []) visit(link.node);
    }
  };
  visit(start);
  return seen;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function secretFromAscii(ascii) {
  return prefix + Buffer.from(ascii, "utf8").toString("base64");
}

function sign(id, rawBody, secret, timestamp) {
  const key = Buffer.from(secret.slice(prefix.length), "base64");
  const mac = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`, "utf8").digest("base64");
  return `v1,${mac}`;
}

function delivery({ id, body, secret, nowMs }) {
  const rawBody = canonical(body);
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": sign(id, rawBody, secret, timestamp),
    },
    rawBody,
    secrets: secret,
    now: nowMs,
  };
}

const send = workflow("p2a-send-and-reply.json");
const wake = workflow("p2a-wake-receive.json");
const poll = workflow("p2a-poll-and-answer.json");
const docs = [send, wake, poll];
const allowedTools = new Set([
  "p2a_send_message",
  "p2a_wait_for_reply",
  "p2a_check_new",
  "claim_request",
  "complete_request",
  "p2a_progress",
]);

test("workflows connect existing nodes", () => {
  for (const doc of docs) {
    assert.ok(Array.isArray(doc.nodes) && doc.nodes.length > 0);
    assert.equal(typeof doc.connections, "object");
    const names = new Set(doc.nodes.map((node) => node.name));
    assert.equal(names.size, doc.nodes.length);
    for (const [from, connection] of Object.entries(doc.connections)) {
      assert.ok(names.has(from), from);
      assert.ok(Array.isArray(connection.main));
      for (const port of connection.main) {
        for (const link of port || []) {
          assert.equal(link.type, "main");
          assert.ok(names.has(link.node), link.node);
        }
      }
    }
    assert.equal(doc.settings.executionOrder, "v1");
    assert.equal(doc.settings.saveExecutionProgress, false);
    assert.equal(doc.nodes.some((node) => node.type === "n8n-nodes-base.wait"), false);
  }
  assert.equal(send.settings.executionTimeout, 300);
  assert.equal(wake.settings.executionTimeout, 50);
  assert.equal(poll.settings.executionTimeout, 50);
  assert.equal(poll.active, false);
});

test("p2a HTTP nodes are stateless tools/call posts", () => {
  for (const doc of docs) {
    for (const node of doc.nodes) {
      if (node.type !== "n8n-nodes-base.httpRequest") continue;
      const url = node.parameters.url || "";
      if (!url.includes("$env.P2A_URL")) continue;
      assert.equal(node.parameters.method, "POST", node.name);
      assert.equal(node.credentials.httpHeaderAuth.name, "p2a agent", node.name);
      const body = node.parameters.jsonBody;
      assert.match(body, /"jsonrpc":"2.0"/, node.name);
      assert.match(body, /"method":"tools\/call"/, node.name);
      const tool = toolName(node);
      assert.ok(allowedTools.has(tool), `${node.name} tool ${tool}`);
      const headers = node.parameters.headerParameters.parameters.map((item) => item.name);
      assert.ok(headers.includes("content-type"), node.name);
      assert.ok(headers.includes("accept"), node.name);
    }
  }
});

test("send retries are off and the wait loop stops at three", () => {
  const sendNode = byName(send).get("send");
  assert.notEqual(sendNode.retryOnFail, true);
  assert.equal(waitSeconds(sendNode), 45);
  assert.ok(sendNode.parameters.options.timeout >= 60000);
  assert.match(sendNode.parameters.jsonBody, /idempotency_key/);
  assert.equal(sendNode.onError, "continueErrorOutput");

  const wait = byName(send).get("wait");
  assert.equal(toolName(wait), "p2a_wait_for_reply");
  assert.notEqual(wait.retryOnFail, true);
  assert.equal(waitSeconds(wait), 45);
  assert.ok(wait.parameters.options.timeout >= 60000);

  const retry = byName(send).get("retry wait?");
  const encoded = JSON.stringify(retry.parameters);
  assert.match(encoded, /"operation":"smaller"/);
  assert.match(encoded, /"rightValue":3/);
  assert.deepEqual(send.connections["retry wait?"].main[0].map((link) => link.node), ["carry"]);
  assert.deepEqual(send.connections.carry.main[0].map((link) => link.node), ["wait"]);
  assert.deepEqual(send.connections["has request_id?"].main[0].map((link) => link.node), ["carry"]);
  assert.deepEqual(send.connections["has request_id?"].main[1].map((link) => link.node), ["send"]);
  assert.match(byName(send).get("input").parameters.assignments.assignments.find((item) => item.name === "idempotency_key").value, /\$execution\.id/);
});

test("wake replies fetch once and polling stays inactive", () => {
  const fetchReply = byName(wake).get("fetch reply");
  assert.equal(toolName(fetchReply), "p2a_wait_for_reply");
  assert.equal(waitSeconds(fetchReply), 0);
  assert.notEqual(fetchReply.retryOnFail, true);

  for (const doc of [wake, poll]) {
    const llm = byName(doc).get("LLM");
    assert.equal(llm.disabled, true);
    assert.equal(llm.parameters.url.includes("$env.P2A_URL"), false);
    const complete = byName(doc).get("complete");
    assert.equal(complete.retryOnFail, true);
    assert.equal(complete.maxTries, 3);
    assert.equal(complete.waitBetweenTries, 5000);
    assert.equal(toolName(complete), "complete_request");
    const claim = byName(doc).get("claim");
    assert.equal(claim.retryOnFail, false);
    assert.equal(claim.maxTries, undefined);
    assert.equal(toolName(claim), "claim_request");
    assert.match(claim.parameters.jsonBody, /lease_seconds:300/);
  }
  const check = byName(poll).get("check new");
  assert.equal(check.retryOnFail, true);
  assert.equal(check.maxTries, 3);
  assert.equal(check.waitBetweenTries, 5000);
  assert.equal(byName(poll).get("every minute").parameters.rule.interval[0].minutesInterval, 1);
});

test("embedded code matches the snippet files", () => {
  const unwrap = read("workflows/snippets/unwrap.js");
  const verify = read("workflows/snippets/verify-webhook.js");
  const dedupe = read("workflows/snippets/dedupe.js");
  let unwrapNodes = 0;
  for (const doc of docs) {
    for (const node of doc.nodes) {
      if (node.type !== "n8n-nodes-base.code") continue;
      if (node.name.startsWith("unwrap")) {
        assert.equal(node.parameters.jsCode, unwrap, node.name);
        unwrapNodes += 1;
      } else if (node.name === "verify") {
        assert.equal(node.parameters.jsCode, verify);
      } else if (node.name === "dedupe") {
        assert.equal(node.parameters.jsCode, dedupe);
      } else {
        assert.equal(node.parameters.mode, "runOnceForAllItems");
      }
    }
  }
  assert.ok(unwrapNodes >= 4);
});

test("wake answers the webhook before any p2a call", () => {
  const webhook = byName(wake).get("wake");
  assert.equal(webhook.parameters.responseMode, "responseNode");
  assert.equal(webhook.parameters.options.rawBody, true);
  assert.equal(webhook.parameters.path, "p2a-wake");
  assert.equal(webhook.parameters.httpMethod, "POST");

  const nodes = byName(wake);
  const visit = (name, responded, stack) => {
    assert.equal(stack.includes(name), false, name);
    const node = nodes.get(name);
    assert.ok(node, name);
    if (node.type === "n8n-nodes-base.httpRequest" && !responded) {
      assert.fail(`${name} runs before the webhook response`);
    }
    const now = responded || node.type === "n8n-nodes-base.respondToWebhook";
    const ports = wake.connections[name]?.main || [];
    const links = ports.flatMap((port) => port || []);
    if (links.length === 0) assert.equal(now, true, `${name} ends without a webhook response`);
    for (const link of links) visit(link.node, now, stack.concat(name));
  };
  visit("valid?", false, []);

  const kind = nodes.get("kind");
  assert.deepEqual(
    kind.parameters.rules.values.map((rule) => rule.outputKey),
    ["verification", "test", "request", "reply", "outcome"],
  );
  assert.match(kind.parameters.rules.values[2].conditions.conditions[1].rightValue, /^0\.1$/);
  const echo = nodes.get("echo challenge");
  assert.match(echo.parameters.responseBody, /challenge/);
  assert.equal(echo.parameters.options.responseCode, 200);
  assert.equal(nodes.get("reject").parameters.options.responseCode, 401);
  assert.equal(nodes.get("reject").parameters.respondWith, "noData");

  const ports = wake.connections.kind.main;
  for (const index of [1, 4, 5]) {
    for (const link of ports[index]) {
      for (const name of reachable(wake, link.node)) {
        const body = JSON.stringify(nodes.get(name).parameters || {});
        assert.equal(body.includes("claim_request"), false, name);
      }
    }
  }
  const requestNodes = [...reachable(wake, ports[2][0].node)].map((name) => nodes.get(name));
  assert.ok(requestNodes.some((node) => (node.parameters?.jsonBody || "").includes("claim_request")));
  const replyBody = [...reachable(wake, ports[3][0].node)].map((name) => JSON.stringify(nodes.get(name).parameters || {})).join("\n");
  assert.equal(replyBody.includes("claim_request"), false);
  assert.match(replyBody, /p2a_wait_for_reply/);

  const owner = JSON.stringify(nodes.get("same owner?").parameters);
  assert.match(owner, /same_owner/);
  assert.equal(owner.includes("untrusted_input"), false);
  assert.equal(owner.includes("body.text"), false);
  assert.equal(wake.connections["duplicate?"].main[0].length, 0);
  assert.equal(wake.connections["duplicate?"].main[1][0].node, "attempt id");
});

test("published files contain no credentials, mail, or private addresses", () => {
  const token = new RegExp(`ibi_|iba_|ibt_|ibr_|${prefix}[A-Za-z0-9]|Bearer [A-Za-z0-9]`);
  const tokenBody = new RegExp(`ibi_[A-Za-z0-9]{8,}|iba_[A-Za-z0-9]{8,}|ibt_[A-Za-z0-9]{8,}|ibr_[A-Za-z0-9]{8,}`);
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const strictRoots = ["workflows", ".env.example", "docker-compose.yml"];
  for (const file of filesUnder(root)) {
    const text = readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    const ip = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
    if (strictRoots.some((rootName) => rel === rootName || rel.startsWith(`${rootName}${path.sep}`))) {
      assert.equal(token.test(text), false, rel);
    }
    assert.equal(tokenBody.test(text), false, rel);
    assert.equal(email.test(text), false, rel);
    assert.equal(text.includes(prefix), false, rel);
    assert.equal(text.includes("support" + "@"), false, rel);
    assert.equal(text.includes("/" + "home" + "/"), false, rel);
    assert.equal(new RegExp("\\b" + "Inter" + "bot" + "\\b").test(text), false, rel);
    assert.equal(/(?<!chat@)\bjd\b/.test(text), false, rel);
    assert.equal(text.includes("p2a-" + "deploy"), false, rel);
    const addresses = text.match(ip) || [];
    for (const address of addresses) assert.equal(address, "127.0.0.1", `${rel} ${address}`);
  }
  const env = read(".env.example");
  for (const line of ["N8N_ENCRYPTION_KEY=", "P2A_URL=", "P2A_RECIPIENT=", "P2A_WEBHOOK_SECRETS=", "LLM_MODEL="]) {
    assert.equal(env.split("\n").includes(line), true, line);
  }
  assert.equal(env.includes("LLM_API_KEY"), false);
});

test("compose pins n8n and allows the crypto builtin", () => {
  const compose = read("docker-compose.yml");
  assert.match(compose, /n8nio\/n8n:1\.123\.101/);
  assert.equal(compose.includes("n8nio/n8n:latest"), false);
  assert.match(compose, /127\.0\.0\.1:/);
  assert.match(compose, /N8N_ENCRYPTION_KEY/);
  assert.match(compose, /NODE_FUNCTION_ALLOW_BUILTIN:\s*crypto/);
  assert.match(compose, /N8N_USER_FOLDER:\s*\/data/);
});

test("unwrap, verify, and dedupe follow the receiver rules", () => {
  const { unwrap } = loadSnippet("unwrap.js");
  assert.deepEqual(unwrap({ result: { content: [{ type: "text", text: '{"status":"ok"}' }] } }), { status: "ok" });
  assert.deepEqual(unwrap({ error: { code: -32603, message: "nope" } }).error, { code: -32603, message: "nope" });
  const limited = unwrap({
    result: { content: [{ type: "text", text: '{"error":"rate_limited","retry_after":12,"request_id":"req_example_n8n_1"}' }] },
  });
  assert.equal(limited.status, "rate_limited");
  assert.equal(limited.error.code, "rate_limited");
  assert.equal(limited.retry_after, 12);

  const { verify } = loadSnippet("verify-webhook.js");
  const { remember } = loadSnippet("dedupe.js");
  const vector = JSON.parse(read("test/fixtures/webhook-vector.json"));
  const now = vector.now_ms;
  const current = secretFromAscii(vector.current_ascii);
  const previous = secretFromAscii(vector.previous_ascii);
  const unrelated = secretFromAscii(vector.unrelated_ascii);

  const good = delivery({ id: vector.request.webhook_id, body: vector.request.body, secret: current, nowMs: now });
  assert.equal(verify(good).valid, true);
  assert.equal(verify(good).body.event_id, vector.request.body.event_id);
  assert.equal(verify(good).body.fetch_with, "claim_request");
  assert.equal("text" in verify(good).body, false);

  const tampered = delivery({ id: vector.request.webhook_id, body: vector.request.body, secret: current, nowMs: now });
  tampered.rawBody = canonical(vector.tampered_request.body);
  const tamperedResult = verify(tampered);
  assert.equal(tamperedResult.valid, false);
  assert.equal(tamperedResult.reason, "signature");

  const stale = delivery({ id: vector.request.webhook_id, body: vector.request.body, secret: current, nowMs: now - 301000 });
  stale.now = now;
  const staleResult = verify(stale);
  assert.equal(staleResult.valid, false);
  assert.equal(staleResult.reason, "timestamp");

  const edge = delivery({ id: vector.request.webhook_id, body: vector.request.body, secret: current, nowMs: now - 300000 });
  edge.now = now;
  assert.equal(verify(edge).valid, true);

  const secondKey = delivery({ id: vector.request.webhook_id, body: vector.request.body, secret: current, nowMs: now });
  secondKey.secrets = `${unrelated},${current}`;
  assert.equal(verify(secondKey).valid, true);

  const oldPrevious = delivery({
    id: vector.request.webhook_id,
    body: vector.request.body,
    secret: previous,
    nowMs: now - 86400000,
  });
  oldPrevious.now = now;
  oldPrevious.secrets = `${current},${previous}`;
  const oldResult = verify(oldPrevious);
  assert.equal(oldResult.valid, false);
  assert.equal(oldResult.reason, "timestamp");

  const freshPrevious = delivery({ id: vector.request.webhook_id, body: vector.request.body, secret: previous, nowMs: now });
  freshPrevious.secrets = `${current},${previous}`;
  assert.equal(verify(freshPrevious).valid, true);

  const challenge = delivery({
    id: vector.verification.webhook_id,
    body: vector.verification.body,
    secret: current,
    nowMs: now,
  });
  const echoed = verify(challenge);
  assert.equal(echoed.valid, true);
  assert.equal(echoed.body.challenge, vector.verification.body.challenge);

  const testWake = delivery({ id: vector.test_wake.webhook_id, body: vector.test_wake.body, secret: current, nowMs: now });
  assert.equal(verify(testWake).body.type, "test");

  const store = {};
  assert.equal(remember(store, vector.request.body.event_id).duplicate, false);
  assert.equal(verify(freshPrevious).valid, true);
  assert.equal(remember(store, vector.request.body.event_id).duplicate, true);

  const ring = {};
  for (let i = 0; i < 501; i += 1) assert.equal(remember(ring, `evt_${i}`).duplicate, false);
  assert.equal(ring.ids.length, 500);
  assert.equal(ring.ids[0], "evt_1");
  assert.equal(ring.ids.at(-1), "evt_500");
  assert.equal(remember(ring, "evt_0").duplicate, false);
  assert.equal(ring.ids.length, 500);
});
