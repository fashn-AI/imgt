import assert from "node:assert/strict";
import test from "node:test";

import {
  containerNameForKey,
  parseResizeJob,
  SingleFlight,
  fetchResizeJob,
} from "../src/jobs";
import {
  CONTAINER_RUNTIME_VERSION,
  DERIVATIVE_PREFIX,
  MAX_SOURCE_BYTES,
} from "../src/constants";
import { RENDERER_VERSION } from "../container/renderer";
import { derivativeKey } from "../src/options";

test("internal jobs accept the quality range and reject invalid JSON qualities", async () => {
  const options = {
    sourceUrl: "https://cdn.example.com/photo.jpg",
    width: 640,
    quality: 80,
  };
  for (const quality of [1, 76, 80, 100]) {
    const job = { ...options, quality };
    const value = {
      ...job,
      outputKey: await derivativeKey(DERIVATIVE_PREFIX, job),
    };
    assert.deepEqual(await parseResizeJob(value, ["cdn.example.com"]), value);
  }
  for (const quality of ["80", null, undefined, 0, 101, 75.5, NaN, Infinity]) {
    const job = { ...options, quality };
    await assert.rejects(
      parseResizeJob(
        {
          ...job,
          outputKey: await derivativeKey(
            DERIVATIVE_PREFIX,
            job as typeof options,
          ),
        },
        ["cdn.example.com"],
      ),
      /invalid job/,
    );
  }
});

test("internal jobs accept arbitrary bounded widths and reject invalid JSON widths", async () => {
  const options = {
    sourceUrl: "https://cdn.example.com/photo.jpg",
    width: 641,
    quality: 77,
  };
  for (const width of [1, 37, 641, 3840]) {
    const job = { ...options, width };
    const value = {
      ...job,
      outputKey: await derivativeKey(DERIVATIVE_PREFIX, job),
    };
    assert.deepEqual(await parseResizeJob(value, ["cdn.example.com"]), value);
  }
  for (const width of [
    "641",
    null,
    undefined,
    0,
    -1,
    3841,
    37.5,
    NaN,
    Infinity,
  ]) {
    const job = { ...options, width };
    await assert.rejects(
      parseResizeJob(
        {
          ...job,
          outputKey: await derivativeKey(
            DERIVATIVE_PREFIX,
            job as typeof options,
          ),
        },
        ["cdn.example.com"],
      ),
      /invalid job/,
    );
  }
});

test("routes a derivative key to a stable container shard", () => {
  const key = "derivatives/v1/abcdef.webp";
  assert.equal(containerNameForKey(key, 4), containerNameForKey(key, 4));
  const prefix = `instance-${RENDERER_VERSION}-${CONTAINER_RUNTIME_VERSION}-${MAX_SOURCE_BYTES}`;
  assert.match(containerNameForKey(key, 4), new RegExp(`^${prefix}-[0-3]$`));

  const shards = new Set(
    Array.from({ length: 64 }, (_, index) =>
      containerNameForKey(`derivative-${index}`, 4),
    ),
  );
  assert.deepEqual(
    shards,
    new Set([`${prefix}-0`, `${prefix}-1`, `${prefix}-2`, `${prefix}-3`]),
  );
});

test("rejects an invalid container shard count", () => {
  assert.throws(() => containerNameForKey("key", 0));
  assert.throws(() => containerNameForKey("key", 1.5));
});

test("coalesces concurrent work with the same key", async () => {
  const singleFlight = new SingleFlight<string>();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = singleFlight.run("same-key", async () => {
    calls += 1;
    await gate;
    return "result";
  });
  const second = singleFlight.run("same-key", async () => {
    calls += 1;
    return "duplicate";
  });

  assert.equal(singleFlight.size, 1);
  assert.equal(singleFlight.has("same-key"), true);
  assert.strictEqual(first, second);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["result", "result"]);
  assert.equal(calls, 1);
  assert.equal(singleFlight.size, 0);

  const afterCompletion = singleFlight.run("same-key", async () => {
    calls += 1;
    return "next";
  });
  assert.equal(await afterCompletion, "next");
  assert.equal(calls, 2);
});

test("clears failed work so it can be retried", async () => {
  const singleFlight = new SingleFlight<string>();
  const failed = singleFlight.run("key", async () => {
    throw new Error("failed");
  });
  await assert.rejects(failed, /failed/);

  const retry = singleFlight.run("key", async () => "recovered");
  assert.equal(await retry, "recovered");
});

test("keeps completed work coalesced until background persistence finishes", async () => {
  const singleFlight = new SingleFlight<string>();
  let calls = 0;
  let releasePersistence!: () => void;
  const persistence = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });

  assert.equal(
    await singleFlight.run(
      "key",
      async () => {
        calls += 1;
        return "result";
      },
      () => persistence,
    ),
    "result",
  );
  assert.equal(singleFlight.size, 1);

  assert.equal(
    await singleFlight.run("key", async () => {
      calls += 1;
      return "duplicate";
    }),
    "result",
  );
  assert.equal(calls, 1);

  releasePersistence();
  await persistence;
  await Promise.resolve();
  assert.equal(singleFlight.size, 0);
});

const resizeJob = {
  outputKey: "derivatives/test.webp",
  sourceUrl: "https://cdn.example.com/image.png",
  width: 640,
  quality: 98,
};

test("a retryable reset uses a new stub and an independent identical job request", async () => {
  let stubs = 0;
  const seen: unknown[] = [];
  const response = await fetchResizeJob(resizeJob, () => {
    const attempt = ++stubs;
    return {
      async fetch(request) {
        seen.push(await request.json());
        if (attempt === 1)
          throw Object.assign(new Error("reset"), { retryable: true });
        return new Response("retained image");
      },
    };
  });
  assert.equal(stubs, 2);
  assert.deepEqual(seen, [resizeJob, resizeJob]);
  assert.equal(await response.text(), "retained image");
});

for (const flags of [
  {},
  { retryable: false },
  { retryable: true, overloaded: true },
]) {
  test(`non-retryable or overloaded job errors are returned promptly: ${JSON.stringify(flags)}`, async () => {
    let calls = 0;
    const cause = Object.assign(new Error("failure"), flags);
    await assert.rejects(
      fetchResizeJob(resizeJob, () => ({
        async fetch() {
          calls++;
          throw cause;
        },
      })),
      (e) => e === cause,
    );
    assert.equal(calls, 1);
  });
}

test("resize reset retries stop after three failed attempts", async () => {
  let calls = 0;
  const cause = Object.assign(new Error("reset"), { retryable: true });
  await assert.rejects(
    fetchResizeJob(resizeJob, () => ({
      async fetch() {
        calls++;
        throw cause;
      },
    })),
    (e) => e === cause,
  );
  assert.equal(calls, 3);
});

test("HTTP job failures are not automatically retried", async () => {
  let calls = 0;
  const response = await fetchResizeJob(resizeJob, () => ({
    async fetch() {
      calls++;
      return new Response("full", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    },
  }));
  assert.equal(calls, 1);
  assert.equal(response.status, 429);
});
