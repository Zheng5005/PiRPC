// Smoke test: two clients, independent sessions.
// 1. Both clients send get_state -> both must get a success response.
// 2. Client A sends a tiny prompt -> text_delta stream + agent_settled.
// 3. Client B must receive nothing while A's run is active (independence).
// Run with the bridge up: node test-smoke.mjs

const url = "ws://localhost:3000/ws";
const results = [];
const check = (name, ok, extra = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

function connect(name) {
  const ws = new WebSocket(url);
  const records = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const rec = JSON.parse(e.data);
    records.push(rec);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(rec)) {
        waiters[i].resolve(rec);
        waiters.splice(i, 1);
      }
    }
  };
  const waitFor = (pred, ms, label) =>
    new Promise((resolve, reject) => {
      const hit = records.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
      waiters.push({ pred, resolve: (r) => { clearTimeout(timer); resolve(r); } });
    });
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return { name, ws, records, waitFor, open, send: (o) => ws.send(JSON.stringify(o)) };
}

const deadline = setTimeout(() => { console.error("global timeout"); process.exit(2); }, 180_000);

const a = connect("A");
const b = connect("B");
await Promise.all([a.open, b.open]);

// 1. get_state on both
a.send({ id: "a-1", type: "get_state" });
b.send({ id: "b-1", type: "get_state" });
const [sa, sb] = await Promise.all([
  a.waitFor((r) => r.type === "response" && r.id === "a-1", 30_000, "get_state A"),
  b.waitFor((r) => r.type === "response" && r.id === "b-1", 30_000, "get_state B"),
]);
check("get_state A succeeds", sa.success === true);
check("get_state B succeeds", sb.success === true);

// 2. prompt on A only
const bCountBefore = b.records.length;
a.send({ id: "a-2", type: "prompt", message: "Reply with exactly: OK" });
const promptResp = await a.waitFor((r) => r.type === "response" && r.id === "a-2", 30_000, "prompt response");
check("prompt accepted", promptResp.success === true, JSON.stringify(promptResp.data));

const deltas = [];
a.waitFor((r) => r.type === "agent_settled", 120_000, "agent_settled").then(() => {
  check("A streamed text deltas", deltas.length > 0, `${deltas.length} deltas, text=${JSON.stringify(deltas.join(""))}`);
  check("agent_settled received on A", true);
  check("B received nothing from A's run", b.records.length === bCountBefore,
        `${b.records.length - bCountBefore} records`);
  const failed = results.filter(([, ok]) => !ok).length;
  clearTimeout(deadline);
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
  a.ws.close(); b.ws.close();
  process.exit(failed === 0 ? 0 : 1);
});
// collect deltas until settled
a.ws.addEventListener("message", (e) => {
  const rec = JSON.parse(e.data);
  if (rec.type === "message_update" && rec.assistantMessageEvent?.type === "text_delta") deltas.push(rec.assistantMessageEvent.delta);
});
