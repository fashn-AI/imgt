import assert from "node:assert/strict";
import test from "node:test";
import { NativeIdleAlarm } from "../src/native-idle";
import { deferred } from "./helpers";

function harness() {
  let now = 1000;
  let running = true;
  let stopped = 0;
  const alarms: number[] = [];
  const idle = new NativeIdleAlarm({
    timeoutMs: 120000,
    running: () => running,
    destroy: async () => {
      stopped += 1;
      running = false;
    },
    setAlarm: async (timestamp) => {
      alarms.push(timestamp);
    },
    serialize: (work) => work(),
    now: () => now,
  });
  return {
    idle,
    alarms,
    setNow(value: number) {
      now = value;
    },
    get stopped() {
      return stopped;
    },
  };
}

test("idle alarm stops compute two minutes after completion, despite pending monitoring", async () => {
  const h = harness();
  await h.idle.run(async () => "image");
  assert.deepEqual(h.alarms, [121000]);
  h.setNow(121000);
  await h.idle.alarm();
  assert.equal(h.stopped, 1);
});

test("an old alarm cannot stop a newer active request or its fresh idle interval", async () => {
  const h = harness();
  await h.idle.run(async () => "first");
  h.setNow(120000);
  const gate = deferred<string>();
  const next = h.idle.run(() => gate.promise);
  h.setNow(121000);
  await h.idle.alarm();
  assert.equal(h.stopped, 0);
  gate.resolve("second");
  await next;
  h.setNow(122000);
  await h.idle.alarm();
  assert.equal(h.stopped, 0);
  h.setNow(241000);
  await h.idle.alarm();
  assert.equal(h.stopped, 1);
});

test("a request failure still schedules idle shutdown; a recovered durable alarm can stop compute", async () => {
  const h = harness();
  await assert.rejects(
    h.idle.run(async () => {
      throw Error("failed");
    }),
  );
  assert.deepEqual(h.alarms, [121000]);
  const recovered = harness();
  recovered.setNow(121000);
  await recovered.idle.alarm();
  assert.equal(recovered.stopped, 1);
});
