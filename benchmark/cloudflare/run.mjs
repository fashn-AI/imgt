import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const report = {
  measuredAt: new Date().toISOString(),
  endpoint: "https://imgt-engine-lab.relferreira.workers.dev",
  build: "late-icc-v2",
  notes: [
    "Sequential fixed-source requests, no derivative caching; rotating engine order. First request includes possible cold start. Encode timing excludes platform boot. Three observations per case are not p95.",
  ],
  rows: [],
};
for (const width of [640, 1920, 3840])
  for (let round = 0; round < 3; round++)
    for (let offset = 0; offset < 3; offset++) {
      const engine = ["sharp", "native", "sharp-late-icc"][(round + offset) % 3];
      const t = performance.now();
      const r = await fetch(`${report.endpoint}/image?w=${width}&q=77&engine=${engine}`, {
        signal: AbortSignal.timeout(30000),
      });
      const b = Buffer.from(await r.arrayBuffer());
      const row = {
        width,
        round,
        engine,
        status: r.status,
        ms: performance.now() - t,
        bytes: b.length,
        hash: createHash("sha256").update(b).digest("hex"),
        build: r.headers.get("x-benchmark-build"),
        timing: r.headers.get("server-timing"),
        ray: r.headers.get("cf-ray"),
      };
      console.log(JSON.stringify(row));
      report.rows.push(row);
      await writeFile("benchmark/cloudflare-engines.json", JSON.stringify(report, null, 2) + "\n");
      if (!r.ok || row.build !== report.build)
        throw Error(`Unexpected response: ${r.status} ${row.build} ${r.ok ? "" : b.toString()}`);
    }
