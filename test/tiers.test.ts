import assert from "node:assert/strict";
import test from "node:test";
import {
  bufferedSourceBytes,
  containerResources,
  TierDispatcher,
  transformSlots,
} from "../src/tiers";
import { MAX_SOURCE_BYTES } from "../src/constants";
import { deferred } from "./helpers";

function dispatcher(
  options: { primarySlots?: number; slots?: number; trigger?: number } = {},
) {
  let now = 0;
  const wakes: ReturnType<typeof deferred<void>>[] = [];
  const d = new TierDispatcher({
    primarySlots: options.primarySlots ?? 1,
    overflow: {
      slots: options.slots ?? 2,
      wakeAtQueuedJobs: options.trigger ?? 2,
      idleTimeoutMs: 30_000,
      wake: () => {
        const wake = deferred<void>();
        wakes.push(wake);
        return wake.promise;
      },
    },
    now: () => now,
  });
  return {
    d,
    wakes,
    tick: (ms: number) => (now += ms),
    signal: () => new AbortController().signal,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("sizes containers at 3 GiB, one encoder and three slots per vCPU", () => {
  assert.deepEqual(containerResources(3), {
    vcpu: 3,
    memoryMib: 9216,
    diskMb: 2000,
  });
  assert.equal(transformSlots(1), 3);
  assert.equal(transformSlots(3), 9);
  assert.equal(
    bufferedSourceBytes(2),
    Math.max(2 * 1024 ** 3, MAX_SOURCE_BYTES),
  );
});

test("uses the primary first and wakes the overflow only once enough jobs wait", async () => {
  const { d, wakes, signal } = dispatcher({ trigger: 2 });
  const first = await d.acquire(signal());
  assert.equal(first.tier, "primary");

  const second = d.acquire(signal());
  await settle();
  assert.equal(wakes.length, 0, "one waiting job does not wake the overflow");
  const third = d.acquire(signal());
  await settle();
  assert.equal(wakes.length, 1);
  assert.equal(d.overflowState, "waking");

  // The primary still serves waiting jobs while the overflow starts.
  first.release();
  assert.equal((await second).tier, "primary");
  wakes[0]!.resolve();
  assert.equal((await third).tier, "overflow");
  assert.equal(d.overflowState, "awake");
});

test("an awake overflow takes jobs immediately and is assumed idle before it stops", async () => {
  const { d, wakes, tick, signal } = dispatcher({ trigger: 1, slots: 1 });
  const primary = await d.acquire(signal());
  const waiting = d.acquire(signal());
  await settle();
  wakes[0]!.resolve();
  const overflow = await waiting;
  assert.equal(overflow.tier, "overflow");

  // Full on both tiers: the next job waits in order.
  const queued = d.acquire(signal());
  overflow.release();
  assert.equal((await queued).tier, "overflow");
  (await queued).release();

  tick(24_999);
  assert.equal(d.overflowState, "awake");
  tick(1);
  assert.equal(d.overflowState, "asleep");
  const next = d.acquire(signal());
  await settle();
  assert.equal(wakes.length, 2, "a new burst wakes it again");
  primary.release();
  assert.equal((await next).tier, "primary");
});

test("a failed wake keeps serving from the primary and retries later", async () => {
  const { d, wakes, tick, signal } = dispatcher({ trigger: 1 });
  const primary = await d.acquire(signal());
  const waiting = d.acquire(signal());
  await settle();
  wakes[0]!.reject(new Error("no capacity"));
  await settle();
  assert.equal(d.overflowState, "asleep");

  const another = d.acquire(signal());
  await settle();
  assert.equal(wakes.length, 1, "retries wait five seconds");
  tick(5000);
  const later = d.acquire(signal());
  await settle();
  assert.equal(wakes.length, 2);

  primary.release();
  assert.equal((await waiting).tier, "primary");
  (await waiting).release();
  assert.equal((await another).tier, "primary");
  void later;
});

test("a canceled waiting job leaves the queue without taking a slot", async () => {
  const { d, signal } = dispatcher({ trigger: 10 });
  const primary = await d.acquire(signal());
  const controller = new AbortController();
  const canceled = d.acquire(controller.signal);
  const next = d.acquire(signal());
  controller.abort(new Error("gone"));
  await assert.rejects(canceled, { message: "gone" });
  assert.equal(d.waiting, 1);
  primary.release();
  primary.release();
  assert.equal((await next).tier, "primary");
  assert.equal(d.waiting, 0);
});

test("without an overflow, jobs wait for the primary", async () => {
  const d = new TierDispatcher({ primarySlots: 1, overflow: null });
  const first = await d.acquire(new AbortController().signal);
  const second = d.acquire(new AbortController().signal);
  assert.equal(d.waiting, 1);
  assert.equal(d.overflowState, "asleep");
  first.release();
  assert.equal((await second).tier, "primary");
});
