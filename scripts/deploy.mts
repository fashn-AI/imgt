import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../imgt.config";
import { RENDERER_VERSION } from "../container/renderer";
import { encodeImage } from "../container/transform";
import {
  DERIVATIVE_PREFIX,
  MAX_SOURCE_BYTES,
  OUTPUT_FORMAT,
  TRANSFORM_TIMEOUT_MS,
} from "../src/constants";
import { containerNameForKey } from "../src/jobs";
import { withPrefix } from "../src/options";
import { inactivityTimeoutMs } from "../src/native-container";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms = 30000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Deployment probe exceeded ${ms}ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function uploadedVersion(output: string): string {
  const version = output.match(
    new RegExp(`(?:Worker Version ID|Current Version ID):\\s*(${UUID})`),
  )?.[1];
  assert.ok(version, "Wrangler did not report a Worker version");
  return version;
}

export async function shardSources(
  source: string,
  nonce: string,
  native: boolean,
): Promise<string[]> {
  const sources: string[] = [];
  for (let shard = 0; shard < config.containers.shards; shard += 1) {
    for (let index = 0; index < 1000; index += 1) {
      const url = new URL(source);
      url.searchParams.set(
        native ? "imgt_native_eval" : "imgt_deploy_eval",
        `${nonce}-${shard}-${index}`,
      );
      // Use Node's synchronous digest in this CLI. On Workers Builds the
      // asynchronous digest stalled between successive HTTP probes. The test
      // compares these keys against the application's Web Crypto implementation.
      const identity = [
        url.href,
        640,
        77,
        OUTPUT_FORMAT,
        config.transforms.webpEffort,
      ].join("\0");
      const digest = createHash("sha256").update(identity).digest("hex");
      const key = withPrefix(DERIVATIVE_PREFIX, `${digest}.${OUTPUT_FORMAT}`);
      if (
        containerNameForKey(key, config.containers.shards) ===
        `instance-${RENDERER_VERSION}-${shard}`
      ) {
        sources.push(url.href);
        break;
      }
    }
  }
  assert.equal(
    sources.length,
    config.containers.shards,
    "Could not select every shard",
  );
  return sources;
}

export async function verifyProbe(
  response: Response,
  expected: Buffer,
  version: string,
  backend: string,
): Promise<string | null> {
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(
    response.status,
    200,
    `Preflight returned HTTP ${response.status}`,
  );
  assert.equal(
    response.headers.get("x-imgt-worker-version"),
    version,
    "Deployment has not propagated",
  );
  assert.equal(
    response.headers.get("x-imgt-container-backend"),
    backend,
    "Unexpected backend",
  );
  assert.equal(
    response.headers.get("x-imgt-cache"),
    "MISS",
    "Preflight must execute a transform",
  );
  assert.equal(response.headers.get("x-imgt-renderer"), RENDERER_VERSION);
  assert.deepEqual(
    body,
    expected,
    "Preflight output differs from the current renderer",
  );
  const boot =
    response.headers
      .get("server-timing")
      ?.match(/container_boot;desc="([a-f0-9-]+)"/)?.[1] ?? null;
  if (backend === "native")
    assert.ok(boot, "Native preflight must identify a Linux boot");
  return boot;
}

interface DeploymentTools {
  run: (args: string[]) => Promise<string>;
  warm: (
    version: string,
    backend: "legacy" | "native",
    attempts: number,
  ) => Promise<void>;
  wait: (ms: number) => Promise<unknown>;
}

export async function gatedDeploy(
  previous: string,
  tools: DeploymentTools,
  nonce: string,
): Promise<string> {
  // versions upload publishes the native named image without rolling out the
  // legacy application. The existing legacy image remains the safe fallback.
  const candidate = uploadedVersion(
    await tools.run([
      "versions",
      "upload",
      "--var",
      "IMGT_CONTAINER_BACKEND:legacy",
      "--var",
      `IMGT_NATIVE_CANARY_PREFIX:${nonce}`,
      "--message",
      "Initialize native image behind legacy traffic",
    ]),
  );
  let fallbackActive = false;
  try {
    await tools.run([
      "versions",
      "deploy",
      `${previous}@100`,
      `${candidate}@0`,
      "--yes",
    ]);
    await tools.warm(candidate, "legacy", 4);
    await tools.run(["versions", "deploy", `${candidate}@100`, "--yes"]);
    fallbackActive = true;
    // New Durable Object code is not selected at 0%. Once selected, allow
    // existing native containers to finish and hit their normal idle alarms.
    console.log(
      "Legacy traffic is active; waiting for native idle shutdown before image preflight.",
    );
    await tools.wait(
      inactivityTimeoutMs(config.containers.sleepAfter) +
        TRANSFORM_TIMEOUT_MS +
        5000,
    );
    await tools.warm(candidate, "native", 4);
    // Reuse exactly the initialized image. A normal deploy would rebuild it
    // and introduce another uninitialized image after the readiness check.
    const promoted = uploadedVersion(
      await tools.run([
        "deploy",
        "--containers-rollout",
        "none",
        "--var",
        "IMGT_CONTAINER_BACKEND:native",
        "--message",
        "Native image passed both shard preflights",
      ]),
    );
    await tools.warm(promoted, "native", 1);
    return promoted;
  } catch (error) {
    // Once initialization starts, keep the verified legacy route if anything
    // fails, including a partially successful promotion or propagation error.
    await tools.run([
      "versions",
      "deploy",
      `${fallbackActive ? candidate : previous}@100`,
      "--yes",
    ]);
    throw error;
  }
}

async function wrangler(args: string[]): Promise<string> {
  console.log(
    JSON.stringify({
      event: "deployment_cli",
      command: args.slice(0, 2).join(" "),
    }),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["node_modules/wrangler/bin/wrangler.js", ...args],
      {
        env: { ...process.env, CI: "true", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "inherit"],
        // Image preprocessing is asynchronous and may take several minutes.
        // Traffic stays on the existing version throughout this upload.
        timeout:
          args[0] === "versions" && args[1] === "upload" ? 600000 : 180000,
      },
    );
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      if (!args.includes("--json")) process.stdout.write(data);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 && !child.killed
        ? resolve(output)
        : reject(
            new Error(
              `Wrangler ${args.slice(0, 2).join(" ")} failed (${code})`,
            ),
          ),
    );
  });
}

async function main(): Promise<void> {
  const [endpoint, suppliedSource] = process.argv.slice(2);
  assert.ok(
    endpoint,
    "Usage: npm run deploy -- https://YOUR_WORKER_ENDPOINT [PUBLIC_SOURCE_URL]",
  );
  assert.equal(new URL(endpoint).protocol, "https:");
  const settings = JSON.parse(await readFile("wrangler.jsonc", "utf8")) as {
    name: string;
  };
  const source =
    suppliedSource ??
    "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&w=1920&q=90";
  const input = await withDeadline(async (signal) => {
    const origin = await fetch(source, { signal, redirect: "error" });
    assert.equal(origin.status, 200, "Preflight source must be available");
    return Buffer.from(await origin.arrayBuffer());
  });
  assert.ok(
    input.length > 0 && input.length <= MAX_SOURCE_BYTES,
    "Preflight source size",
  );
  const expected = await encodeImage(
    input,
    { width: 640, quality: 77, effort: config.transforms.webpEffort },
    Date.now() + 20000,
    new AbortController().signal,
  );
  const deployments = JSON.parse(
    await wrangler(["deployments", "list", "--json"]),
  ) as {
    created_on: string;
    versions: { version_id: string; percentage: number }[];
  }[];
  const latest = deployments.sort((a, b) =>
    b.created_on.localeCompare(a.created_on),
  )[0];
  const active = latest?.versions.filter(({ percentage }) => percentage > 0);
  assert.equal(
    active?.length,
    1,
    "Gate requires one active production version",
  );
  assert.equal(active[0].percentage, 100);
  const nonce = randomUUID();
  const tools: DeploymentTools = {
    run: wrangler,
    wait: delay,
    async warm(version, backend, attempts) {
      // A fresh key per phase proves the container runs; EDGE/R2 cannot pass.
      const phase = randomUUID();
      for (let shard = 0; shard < config.containers.shards; shard += 1) {
        let lastError: unknown;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          console.log(
            JSON.stringify({
              event: "deployment_shard_probe",
              version,
              backend,
              shard,
              attempt,
            }),
          );
          const sources = await shardSources(
            source,
            `${nonce}-${phase}-${attempt}`,
            backend === "native",
          );
          const url = new URL("/image", endpoint);
          url.search = new URLSearchParams({
            url: sources[shard],
            w: "640",
            q: "77",
          }).toString();
          try {
            const boot = await withDeadline(async (signal) => {
              const response = await fetch(url, {
                headers: {
                  "Cloudflare-Workers-Version-Overrides": `${settings.name}="${version}"`,
                },
                signal,
              });
              return verifyProbe(response, expected, version, backend);
            });
            console.log(
              JSON.stringify({
                event: "deployment_shard_ready",
                backend,
                shard,
                version,
                boot,
                attempt,
              }),
            );
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            console.log(
              JSON.stringify({
                event: "deployment_shard_retry",
                backend,
                shard,
                attempt,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
            if (attempt < attempts) await delay(10000);
          }
        }
        if (lastError) throw lastError;
      }
    },
  };
  const version = await gatedDeploy(active[0].version_id, tools, nonce);
  console.log(JSON.stringify({ event: "deployment_ready", version }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
