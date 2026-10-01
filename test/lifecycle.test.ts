import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import sharp from "sharp";

test(
  "SIGTERM drains an accepted upload and exits without waiting for forced shutdown",
  { timeout: 7000 },
  async (t) => {
    const child = spawn(process.execPath, ["container/server.ts"], {
      env: { ...process.env, PORT: "0", TRANSFORM_TIMEOUT_MS: "2000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    const exited = once(child, "exit");
    const [chunk] = await once(child.stdout, "data");
    const listening = JSON.parse(String(chunk)) as {
      event: string;
      port: number;
    };
    assert.equal(listening.event, "container_listening");
    const port = listening.port;
    assert.ok(port > 0);
    const input = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const request = http.request(
      `http://127.0.0.1:${port}/transform?w=16&q=77`,
      {
        method: "POST",
        headers: {
          "content-length": input.length,
          "x-imgt-deadline": String(Date.now() + 2000),
        },
      },
    );
    const received = once(request, "response");
    request.write(input.subarray(0, 1));
    // Observe admission before signaling; completing the upload must still work.
    let uploading = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      uploading =
        ((await health.json()) as { uploading: number }).uploading === 1;
      if (uploading) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(uploading);
    child.kill("SIGTERM");
    request.end(input.subarray(1));
    const [response] = await received;
    assert.equal(response.statusCode, 200);
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(Buffer.from(chunk));
    assert.equal((await sharp(Buffer.concat(chunks)).metadata()).width, 16);
    assert.deepEqual(await exited, [0, null]);
  },
);
