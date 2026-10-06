import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
import test from "node:test";
import http from "node:http";
import sharp from "sharp";
let serial = 0;
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const input = await sharp({
  create: { width: 16, height: 8, channels: 3, background: "red" },
})
  .png()
  .toBuffer();
// High-entropy input makes a native encode exceed the short test deadline.
const pixels = Buffer.alloc(3000 * 3000 * 3);
let random = 42;
for (let i = 0; i < pixels.length; i++) {
  random ^= random << 13;
  random ^= random >>> 17;
  random ^= random << 5;
  pixels[i] = random & 255;
}
const largeInput = await sharp(pixels, {
  raw: { width: 3000, height: 3000, channels: 3 },
})
  .jpeg()
  .toBuffer();
async function start(engine, env = {}) {
  const name = `imgt-rust-http-contract-${engine}-${serial++}`;
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--cpus=2",
    "--memory=1g",
    "--memory-swap=1g",
    "-p",
    "127.0.0.1::8080",
  ];
  for (const [k, v] of Object.entries({
    TRANSFORM_CONCURRENCY: 2,
    MAX_IN_FLIGHT: 8,
    TRANSFORM_TIMEOUT_MS: 3000,
    ...env,
  }))
    args.push("-e", `${k}=${v}`);
  args.push(
    env.IMGT_TEST_RENDER_DELAY_MS
      ? process.env.IMGT_TEST_IMAGE
      : process.env.IMGT_CONTAINER_IMAGE,
  );
  docker(...args);
  const port = +docker("port", name, "8080/tcp").split(":").at(-1),
    url = `http://127.0.0.1:${port}`;
  const health = () => fetch(`${url}/health`).then((r) => r.json());
  for (let i = 0; i < 100; i++) {
    try {
      await health();
      break;
    } catch {}
    await sleep(10);
  }
  const post = (
    body = input,
    deadline = Date.now() + 3000,
    query = "w=32&q=77",
    signal,
  ) =>
    fetch(`${url}/transform?${query}`, {
      method: "POST",
      body,
      signal,
      headers: { "x-imgt-deadline": String(deadline) },
    });
  return {
    name,
    url,
    port,
    health,
    post,
    close: () => {
      try {
        docker("rm", "-f", name);
      } catch {}
    },
  };
}
async function until(test, limit = 1000) {
  const end = Date.now() + limit;
  while (!(await test())) {
    if (Date.now() > end) throw Error("condition timed out");
    await sleep(5);
  }
}
function stream(s, deadline, len) {
  let resolve, reject;
  const response = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  const request = http.request(
    `${s.url}/transform?w=32&q=77`,
    {
      method: "POST",
      headers: {
        "x-imgt-deadline": String(deadline),
        ...(len ? { "content-length": len } : {}),
      },
    },
    (r) => {
      r.resume();
      resolve(r.statusCode);
    },
  );
  request.on("error", reject);
  response.catch(() => {});
  return { request, response };
}
const tests = [
  [
    "validation and byte limits",
    {},
    async (s) => {
      assert.equal((await s.post(input, Date.now() - 5000)).status, 504);
      assert.equal(
        (
          await fetch(`${s.url}/transform?w=32&q=77`, {
            method: "POST",
            body: input,
          })
        ).status,
        400,
      );
      for (const q of ["w=0&q=77", "w=32&q=0", "w=32&q=101", "w=1.5&q=77"])
        assert.equal((await s.post(input, Date.now() + 3000, q)).status, 400);
      for (const path of ["/transform", "/missing"])
        assert.equal((await fetch(s.url + path)).status, 404);
      assert.equal((await s.post(Buffer.alloc(0))).status, 400);
      assert.equal((await s.post(Buffer.from("invalid"))).status, 400);
      const r = await s.post();
      assert.equal(r.status, 200);
      assert.equal(
        (await sharp(Buffer.from(await r.arrayBuffer())).metadata()).width,
        16,
      );
    },
  ],
  [
    "declared and chunked oversize uploads",
    { MAX_INPUT_BYTES: 8 },
    async (s) => {
      assert.equal((await s.post(Buffer.alloc(9))).status, 413);
      const x = stream(s, Date.now() + 3000);
      x.request.write(Buffer.alloc(9));
      x.request.end();
      assert.equal(await x.response, 413);
    },
  ],
  [
    "pixel limit",
    {},
    async (s) => {
      assert.equal(
        (
          await s.post(
            await sharp({
              create: {
                width: 7100,
                height: 7100,
                channels: 3,
                background: "red",
              },
            })
              .png()
              .toBuffer(),
          )
        ).status,
        400,
      );
    },
  ],
  [
    "ready images bypass stalled uploads",
    {},
    async (s) => {
      const x = stream(s, Date.now() + 3000, input.length);
      x.request.write(input.subarray(0, 1));
      try {
        await until(async () => (await s.health()).uploading === 1);
        assert.equal((await s.post()).status, 200);
        assert.equal((await s.health()).uploading, 1);
        x.request.end(input.subarray(1));
        assert.equal(await x.response, 200);
      } finally {
        x.request.destroy();
      }
    },
  ],
  [
    "upload timeout releases admission",
    { MAX_IN_FLIGHT: 1 },
    async (s) => {
      const x = stream(s, Date.now() + 100, 100);
      x.request.write("x");
      try {
        assert.equal(await x.response, 504);
        await until(async () => (await s.health()).inFlight === 0);
        assert.equal((await s.post()).status, 200);
      } finally {
        x.request.destroy();
      }
    },
  ],
  [
    "upload disconnect releases admission",
    { MAX_IN_FLIGHT: 1 },
    async (s) => {
      const x = stream(s, Date.now() + 3000, 100);
      x.request.write("x");
      await until(async () => (await s.health()).uploading === 1);
      x.request.destroy();
      await until(async () => (await s.health()).inFlight === 0);
      assert.equal((await s.post()).status, 200);
    },
  ],
  [
    "bounded admission returns retryable 429",
    { MAX_IN_FLIGHT: 2, IMGT_TEST_RENDER_DELAY_MS: 500 },
    async (s) => {
      const a = s.post(),
        b = s.post();
      await until(async () => (await s.health()).inFlight === 2);
      const rejected = await s.post();
      assert.equal(rejected.status, 429);
      assert.equal(rejected.headers.get("retry-after"), "1");
      assert.equal(rejected.headers.get("cache-control"), "no-store");
      assert.equal((await a).status, 200);
      assert.equal((await b).status, 200);
    },
  ],
  [
    "queued deadline is removed",
    { TRANSFORM_CONCURRENCY: 1, IMGT_TEST_RENDER_DELAY_MS: 500 },
    async (s) => {
      const a = s.post();
      await until(async () => (await s.health()).active);
      assert.equal((await s.post(input, Date.now() + 80)).status, 504);
      await until(async () => (await s.health()).queued === 0);
      assert.equal((await a).status, 200);
    },
  ],
  [
    "queued disconnect is removed",
    { TRANSFORM_CONCURRENCY: 1, IMGT_TEST_RENDER_DELAY_MS: 700 },
    async (s) => {
      const a = s.post();
      await until(async () => (await s.health()).active);
      const c = new AbortController();
      const b = s.post(input, Date.now() + 3000, "w=32&q=77", c.signal);
      const gone = assert.rejects(b);
      await until(async () => (await s.health()).queued === 1);
      c.abort();
      await gone;
      await until(async () => (await s.health()).queued === 0, 300);
      assert.equal((await a).status, 200);
    },
  ],
  [
    "active timeout retains its slot",
    {
      TRANSFORM_CONCURRENCY: 1,
      MAX_IN_FLIGHT: 1,
      IMGT_TEST_RENDER_DELAY_MS: 500,
    },
    async (s) => {
      const a = s.post(input, Date.now() + 80);
      await until(async () => (await s.health()).active);
      assert.equal((await a).status, 504);
      assert.equal((await s.post()).status, 429);
      assert.equal((await s.health()).inFlight, 1);
      await until(async () => (await s.health()).inFlight === 0);
      assert.equal((await s.post()).status, 200);
    },
  ],
  [
    "active disconnect retains its slot",
    {
      TRANSFORM_CONCURRENCY: 1,
      MAX_IN_FLIGHT: 1,
      IMGT_TEST_RENDER_DELAY_MS: 500,
    },
    async (s) => {
      const c = new AbortController();
      const a = s.post(input, Date.now() + 3000, "w=32&q=77", c.signal);
      const gone = assert.rejects(a);
      await until(async () => (await s.health()).active);
      c.abort();
      await gone;
      assert.equal((await s.post()).status, 429);
      assert.equal((await s.health()).inFlight, 1);
      await until(async () => (await s.health()).inFlight === 0);
      assert.equal((await s.post()).status, 200);
    },
  ],
  [
    "real native deadline recovers",
    {},
    async (s) => {
      const result = await s.post(largeInput, Date.now() + 100, "w=3000&q=98");
      assert.equal(result.status, 504);
      await until(async () => (await s.health()).inFlight === 0, 3000);
      assert.equal((await s.post()).status, 200);
    },
  ],
  [
    "SIGTERM drains an admitted upload",
    {},
    async (s) => {
      const x = stream(s, Date.now() + 3000, input.length);
      x.request.write(input.subarray(0, 1));
      await until(async () => (await s.health()).uploading === 1);
      docker("kill", "--signal=SIGTERM", s.name);
      x.request.end(input.subarray(1));
      assert.equal(await x.response, 200);
      assert.equal((await run("docker", ["wait", s.name])).stdout.trim(), "0");
    },
  ],
];
for (const [name, env, check] of tests) {
  test(name, async () => {
    const server = await start("rust", env);
    try {
      await check(server);
    } finally {
      server.close();
    }
  });
}

test("Rust matches Sharp for supported formats, orientation, color and alpha", async () => {
  const { encodeImage } = await import("../container/transform.ts");
  const rgba = Buffer.from(
    Array.from({ length: 65 * 39 * 4 }, (_, i) => (i * 73 + (i >> 5)) % 256),
  );
  const base = sharp(rgba, { raw: { width: 65, height: 39, channels: 4 } });
  const fixtures = [];
  for (const format of ["png", "jpeg", "webp", "avif"])
    fixtures.push(await base.clone()[format]().toBuffer());
  for (let orientation = 1; orientation <= 8; orientation++)
    fixtures.push(
      await base.clone().jpeg().withMetadata({ orientation }).toBuffer(),
    );
  fixtures.push(await base.clone().withIccProfile("p3").png().toBuffer());
  fixtures.push(await base.clone().toColourspace("b-w").png().toBuffer());
  fixtures.push(await base.clone().toColourspace("rgb16").png().toBuffer());
  fixtures.push(await base.clone().toColourspace("cmyk").jpeg().toBuffer());
  const server = await start("rust");
  try {
    for (const input of fixtures)
      for (const width of [1, 37, 100])
        for (const quality of [1, 77, 98, 100]) {
          const expected = await encodeImage(
            input,
            { width, quality, effort: 4 },
            Date.now() + 10000,
            new AbortController().signal,
          );
          const response = await server.post(
            input,
            Date.now() + 10000,
            `w=${width}&q=${quality}`,
          );
          assert.equal(response.status, 200);
          const actual = Buffer.from(await response.arrayBuffer());
          assert.deepEqual(actual, expected);
          await sharp(actual).raw().toBuffer();
        }
  } finally {
    server.close();
  }
});
