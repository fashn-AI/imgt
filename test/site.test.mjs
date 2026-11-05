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
      /<!-- (?:SETUP_PROMPT|SUMMARY|SPEED_CHART|COST_CHART|COST_BREAKDOWN) -->/,
    );
    assert.doesNotMatch(page, /\u2014/);
  }
  const benchmarks = await readFile(new URL("benchmarks.html", assets), "utf8");
  const speedChart = benchmarks.match(
    /id="speed-chart"[\s\S]*?<\/section>/,
  )?.[0];
  assert.ok(speedChart);
  assert.equal(speedChart.match(/class="compare-row"/g)?.length, 5);
  assert.equal(speedChart.match(/<rect width="[1-9][\d.]*"/g)?.length, 10);
  assert.match(speedChart, /About the same/);
  assert.match(speedChart, /Vercel 5\.7× faster/);
  assert.doesNotMatch(speedChart, /No successes|Not measured/);
  assert.match(benchmarks, /\$60\.18/);
  assert.match(benchmarks, /\$250\.93/);
  assert.match(benchmarks, /4× cheaper/);
  assert.doesNotMatch(benchmarks, /benchmarks\.js|<select/);
  assert.doesNotMatch(benchmarks, /comparison in progress|cost-inputs/);
  const agents = await readFile(new URL("llms-full.txt", assets), "utf8");
  assert.match(agents, /Source: \/docs\/benchmarks\.md/);
});
