import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { claudeExtractor } from "../dist/llm.js";
import { createDeskServer } from "../dist/server.js";

// Expected from the fixture's configured stock, email facts, and daily caps.
const expected = Object.fromEntries(`
ORD-1001 CORVANE
ORD-1002 VELMORA
ORD-1003 ISHBY
ORD-1004 TANDREL
ORD-1005 TANDREL
ORD-1006 TANDREL
ORD-1007 TANDREL
ORD-1008 WRENFOLD
ORD-1009 MANUAL
ORD-1010 WRENFOLD
ORD-1011 CORVANE
ORD-1012 VELMORA
ORD-1013 ISHBY
ORD-2001 TANDREL
ORD-2002 VELMORA
ORD-2003 VELMORA
ORD-2004 MANUAL
ORD-2005 TANDREL
ORD-2006 CORVANE
ORD-2007 VELMORA
ORD-2008 ISHBY
ORD-2009 TANDREL
ORD-2010 TANDREL
ORD-2011 CORVANE
ORD-2012 MANUAL
ORD-2013 VELMORA
ORD-3001 TANDREL
ORD-3002 MANUAL
ORD-3003 VELMORA
ORD-3004 TANDREL
ORD-3005 WRENFOLD
ORD-3006 TANDREL
ORD-3007 VELMORA
ORD-3008 TANDREL
ORD-3009 MANUAL
ORD-3010 ISHBY
ORD-3011 VELMORA
ORD-3012 ISHBY
`.trim().split("\n").map((row) => row.split(" ")));

const dated = (pharmacyId, rule, from = null, until = null) => ({ pharmacyId, from, until, rule });
const stock = (pharmacy, medication, dose, available, until = null) =>
  dated(pharmacy, { kind: "stock", medication, dose, available }, null, until);

const interpretations = new Map(Object.entries({
  evt_001: [stock("TANDREL", "tirzepatide", "5mg", false, "2026-11-11")],
  evt_002: [dated("CORVANE", { kind: "shipping", state: "Florida", allowed: false }, "2026-11-11")],
  evt_004: [stock("ISHBY", "tirzepatide", "25mg", true)],
  evt_014: [dated("WRENFOLD", { kind: "open", value: false }, "2026-11-10", "2026-11-11")],
  evt_017: [stock("TANDREL", "tirzepatide", "5mg", true), stock("TANDREL", "tirzepatide", "7.5mg", false, "2026-11-11")],
  evt_020: [dated("CORVANE", { kind: "capacity", value: 2 }, null, "2026-11-16")],
  evt_022: [dated("TANDREL", { kind: "shipping", state: "TX", allowed: false })],
  evt_027: [dated("VELMORA", { kind: "routing", action: "prefer", scope: { medication: "semaglutide" } }, "2026-11-11", "2026-11-16")],
  evt_040: [stock("VELMORA", "semaglutide", "1mg", false, "2026-11-13")],
}));

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function close(server) {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  return closed;
}

async function jsonl(path) {
  const file = await readFile(path, "utf8");
  return file.trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("the official replay dispatches each order exactly once to the expected destination", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "desk-rebuild-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reviewPath = join(directory, "reviews.jsonl");
  const ordersPath = join(directory, "orders.jsonl");
  const deliveriesPath = join(directory, "deliveries.jsonl");
  const events = await jsonl("sim/week-a.jsonl");
  const mail = new Map(events.filter(({ type }) => type === "email")
    .map(({ occurred_at, event_id }) => [new Date(occurred_at).toISOString(), event_id]));
  const calls = [];
  const modelErrors = [];
  const model = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/messages");
      assert.equal(request.headers["x-api-key"], "loopback-only");
      const buffers = [];
      for await (const chunk of request) buffers.push(chunk);
      const input = JSON.parse(Buffer.concat(buffers).toString());
      assert.equal(input.model, "claude-sonnet-4-6");
      assert.equal(input.output_config.format.type, "json_schema");
      const id = mail.get(JSON.parse(input.messages[0].content).now);
      assert.ok(interpretations.has(id));
      calls.push(id);
      if (calls.length === 1) {
        response.writeHead(503).end();
        return;
      }
      const text = JSON.stringify({ status: "apply", changes: interpretations.get(id) });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        content: [{ type: "text", text }],
      }));
    } catch (error) {
      modelErrors.push(error);
      response.writeHead(500).end();
    }
  });
  const modelPort = await listen(model);
  t.after(() => close(model));
  const extract = claudeExtractor({
    ANTHROPIC_API_KEY: "loopback-only",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
  });
  const desk = createDeskServer(extract, reviewPath);
  const deskPort = await listen(desk);
  t.after(() => close(desk));
  const reservation = createServer();
  const pharmacyPort = await listen(reservation);
  await close(reservation);

  const { stdout } = await promisify(execFile)(process.execPath, [
    "sim/sim.mjs",
    "--target", `http://127.0.0.1:${deskPort}/webhooks`,
    "--pharmacy-port", String(pharmacyPort),
    "--log", ordersPath,
    "--deliveries", deliveriesPath,
    "--timeout", "3000",
    "--drain", "1",
    "--quiet",
  ], { timeout: 12_000 });
  assert.match(stdout, /52 of 52 events; 38 of 38 orders .* no problems/);
  assert.deepEqual(modelErrors, []);
  assert.deepEqual(calls, ["evt_001", ...interpretations.keys()]);
  const orders = await jsonl(ordersPath);
  assert.equal(orders.length, 38);
  assert.deepEqual(Object.fromEntries(orders.map(({ order_id, pharmacy }) => [order_id, pharmacy])), expected);
  assert.ok(orders.every(({ late }) => !late));
  assert.deepEqual((await jsonl(reviewPath)).map(({ event_id }) => event_id), ["evt_003", "evt_004"]);
  assert.ok((await jsonl(deliveriesPath)).every(({ status }) => status === 204));
});
