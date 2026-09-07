// Isolates transform CPU/memory; excludes HTTP, origin, R2, and Cloudflare startup.
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cpus } from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";

const input = resolve(process.env.FIXTURES ?? "/tmp/imgt-engine-fixtures");
const output = resolve(process.env.ENGINE_OUTPUT_DIR ?? "/tmp/imgt-engine-results");
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(join(input, "manifest.json"), "utf8"));
const count = Number(process.env.ENGINE_SAMPLES ?? 3);
if (!Number.isInteger(count) || count < 1 || count > 10)
  throw new Error("ENGINE_SAMPLES must be 1–10");
const cpuLimit = Number(process.env.ENGINE_CPUS ?? 1);
const vipsThreads = Number(process.env.ENGINE_VIPS_CONCURRENCY ?? 1);
if (![1, 2].includes(cpuLimit) || ![1, 2].includes(vipsThreads))
  throw new Error("CPU/thread screen supports 1 or 2");
const memoryMiB = cpuLimit * 3072;
const fixtures = manifest.files.filter(
  (f) => !process.env.ENGINE_FIXTURES || process.env.ENGINE_FIXTURES.split(",").includes(f.name),
);
if (!fixtures.length) throw new Error("No matching fixtures");
const profiles = [
  {
    name: "sharp-cache64",
    image: "imgt-engines:local",
    command: ["node", "/app/benchmark/engines/sharp.mjs"],
    env: [],
  },
  {
    name: "sharp-cache0",
    image: "imgt-engines:local",
    command: ["node", "/app/benchmark/engines/sharp.mjs"],
    env: ["SHARP_CACHE=0"],
  },
  {
    name: "sharp-late-icc",
    image: "imgt-engines:local",
    command: ["node", "/app/benchmark/engines/sharp.mjs"],
    env: ["SHARP_CACHE=0", "SHARP_LATE_ICC=1"],
  },
  { name: "native-vips", image: "imgt-engines:local", command: ["/app/native"], env: [] },
  { name: "rust-fir", image: "imgt-rust:local", command: [], env: [] },
].filter(
  (p) => !process.env.ENGINE_PROFILE || process.env.ENGINE_PROFILE.split(",").includes(p.name),
);
if (!profiles.length) throw new Error("Unknown ENGINE_PROFILE");
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 60000 }).trim();
const report = {
  date: new Date().toISOString(),
  cpu: cpus()[0].model,
  hostCpus: cpus().length,
  limits: { cpu: cpuLimit, memoryMiB },
  vipsThreads,
  count,
  manifest,
  profiles: [],
};
for (const profile of profiles) {
  const name = `imgt-engine-${profile.name}-${process.pid}`;
  const result = {
    name: profile.name,
    image: profile.image,
    architecture: docker("image", "inspect", profile.image, "--format", "{{.Architecture}}"),
    rows: [],
  };
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--cpus",
    String(cpuLimit),
    "--memory",
    `${memoryMiB}m`,
    "--memory-swap",
    `${memoryMiB}m`,
    "-v",
    `${input}:/fixtures:ro`,
    "-v",
    `${output}:/results`,
    ...profile.env.flatMap((v) => ["-e", v]),
    "-e",
    `VIPS_CONCURRENCY=${vipsThreads}`,
    profile.image,
    ...profile.command,
  ];
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  let pending,
    lines = [],
    failure;
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(line);
    } else lines.push(line);
  });
  child.stderr.on("data", (data) => process.stderr.write(data));
  child.on("error", (e) => {
    failure = e;
  });
  child.on("exit", (code) => {
    if (code) {
      failure = new Error(`Engine exited ${code}`);
      if (pending) {
        pending(JSON.stringify({ ok: false, error: failure.message }));
        pending = null;
      }
    }
  });
  async function next() {
    if (failure) throw failure;
    if (lines.length) return lines.shift();
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve) => {
          pending = resolve;
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Engine protocol timed out")), 60000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      pending = null;
    }
  }
  try {
    result.ready = JSON.parse(await next());
    if (!result.ready.ready) throw new Error(result.ready.error ?? "Engine did not become ready");
    result.idleMemoryMiB =
      Number(docker("exec", name, "cat", "/sys/fs/cgroup/memory.current")) / 1048576;
    for (const fixture of fixtures) {
      const widths =
        fixture.name.startsWith("portrait") || fixture.name.startsWith("landscape")
          ? [640, 1920, 3840]
          : [384];
      for (const width of widths) {
        const runs = [];
        for (let i = 0; i < count; i++) {
          const filename = `${profile.name}-${fixture.name}-${width}.webp`;
          child.stdin.write(`/fixtures/${fixture.name}\t${width}\t77\t2\t/results/${filename}\n`);
          const row = JSON.parse(await next());
          if (row.ok) {
            const body = await readFile(join(output, filename));
            row.hash = createHash("sha256").update(body).digest("hex");
            const metadata = await sharp(body).metadata();
            row.width = metadata.width;
            row.height = metadata.height;
            row.alpha = metadata.hasAlpha;
            row.format = metadata.format;
            const oriented = [5, 6, 7, 8].includes(fixture.orientation);
            const sourceW = oriented ? fixture.height : fixture.width,
              sourceH = oriented ? fixture.width : fixture.height;
            const expectedW = Math.min(width, sourceW),
              expectedH = Math.round((sourceH * expectedW) / sourceW);
            row.dimensionsCorrect =
              row.width === expectedW && Math.abs(row.height - expectedH) <= 1;
            if (!row.dimensionsCorrect || row.format !== "webp")
              row.validationError = "Output dimensions/format mismatch";
          }
          runs.push(row);
        }
        result.rows.push({ source: fixture.name, width, runs });
        console.log(JSON.stringify({ profile: profile.name, source: fixture.name, width, runs }));
      }
    }
    result.peakMemoryMiB =
      Number(docker("exec", name, "cat", "/sys/fs/cgroup/memory.peak")) / 1048576;
  } catch (e) {
    result.error = e.message;
  } finally {
    child.stdin.end();
    try {
      docker("rm", "-f", name);
    } catch {}
  }
  report.profiles.push(result);
  await writeFile(
    process.env.ENGINE_REPORT ?? "benchmark/engines-local.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
if (
  report.profiles.some(
    (p) => p.error || p.rows.some((row) => row.runs.some((run) => !run.ok || run.validationError)),
  )
) {
  process.exitCode = 1;
}
