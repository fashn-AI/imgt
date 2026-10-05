import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

test("built benchmark charts work without scripts and both JSON-LD blocks satisfy CSP", async () => {
  const root = new URL("../", import.meta.url);
  await promisify(execFile)(process.execPath, ["scripts/build-site.mjs"], {
    cwd: root,
  });
  const assets = new URL("dist/public/", root);
  const headers = await readFile(new URL("_headers", assets), "utf8");
  for (const filename of ["index.html", "benchmarks.html"]) {
    const page = await readFile(new URL(filename, assets), "utf8");
    for (const match of page.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    )) {
      const hash = createHash("sha256").update(match[1]).digest("base64");
      assert.ok(headers.includes(`'sha256-${hash}'`));
      JSON.parse(match[1]);
    }
    assert.doesNotMatch(
      page,
      /<!-- (?:SETUP_PROMPT|LATENCY_CHART|COST_CHART|COST_BREAKDOWN|LOWER_RESULTS) -->/,
    );
    assert.doesNotMatch(page, /\u2014/);
  }
  const benchmarks = await readFile(new URL("benchmarks.html", assets), "utf8");
  assert.match(benchmarks, /1\.755 s/);
  assert.match(benchmarks, /\$187\.69/);
  assert.match(benchmarks, /\$223\.20/);
  const agents = await readFile(new URL("llms-full.txt", assets), "utf8");
  assert.match(agents, /Source: \/docs\/benchmarks\.md/);
});
