import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createHighlighter } from "shiki";
import { allocations, estimateCosts } from "../public/benchmark-costs.js";
import {
  cachedP95Ms,
  comparisonRows,
  costScenario,
  imgtAllocation,
} from "../public/benchmark-data.js";

const root = new URL("../", import.meta.url);
const assets = new URL("dist/public/", root);
await rm(assets, { recursive: true, force: true });
await cp(new URL("public/", root), assets, { recursive: true });

const highlighter = await createHighlighter({
  langs: ["ts", "tsx"],
  themes: ["github-dark-default"],
});
const styles = new Map();
let html = await readFile(new URL("index.html", assets), "utf8");
const prompt = await readFile(new URL("docs/setup-prompt.md", root), "utf8");
html = html.replace(
  "<!-- SETUP_PROMPT -->",
  prompt
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;"),
);
for (const match of html.matchAll(
  /(<code\b[^>]*data-language="([^"]+)"[^>]*>)([\s\S]*?)(<\/code>)/g,
)) {
  const code = match[3]
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  let highlighted = highlighter
    .codeToHtml(code, { lang: match[2], theme: "github-dark-default" })
    .match(/<code>([\s\S]*?)<\/code>/)[1];
  // Emit external CSS so highlighting works with style-src 'self'.
  highlighted = highlighted.replace(/ style="([^"]+)"/g, (_, style) => {
    if (!styles.has(style)) styles.set(style, `syntax-${styles.size}`);
    return ` class="${styles.get(style)}"`;
  });
  html = html.replace(match[0], match[1] + highlighted + match[4]);
}
highlighter.dispose();
await writeFile(new URL("index.html", assets), html);
await writeFile(
  new URL("syntax.css", assets),
  [...styles].map(([style, name]) => `.${name}{${style}}`).join("\n") + "\n",
);

const currency = (value) => `$${value.toFixed(2)}`;
const duration = (value) =>
  value === null ? "No successes" : `${value.toFixed(2)} s`;
const escape = (text) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const bar = (value, maximum) =>
  `<svg viewBox="0 0 1000 20" preserveAspectRatio="none" aria-hidden="true"><rect width="${(((value ?? 0) / maximum) * 1000).toFixed(1)}" height="20" rx="2" /></svg>`;

// One shared scale across workloads, so short bars really are short.
const rows = comparisonRows();
const slowest =
  Math.max(
    0.001,
    ...rows.flatMap((row) => [row.values.imgt ?? 0, row.values.vercel ?? 0]),
  ) * 1.02;
const speedChart = rows
  .map((row) => {
    const status = row.allSucceeded
      ? "Every request succeeded"
      : `imgt ${row.statuses.imgt} · Vercel ${row.statuses.vercel}`;
    const series = [
      ["imgt", "imgt", row.values.imgt],
      ["vercel", "Vercel", row.values.vercel],
    ]
      .map(
        ([id, name, value]) =>
          `<div class="compare-bar ${id}"><span class="compare-name">${name}</span>${bar(value, slowest)}<span class="compare-value">${duration(value)}</span></div>`,
      )
      .join("");
    return `<div class="compare-row" data-workload="${row.id}"><div class="compare-label"><strong>${escape(row.name)}</strong><small>${escape(row.detail)}</small><span class="verdict ${row.verdict.winner ?? "none"}">${row.verdict.label}</span></div><div class="compare-bars">${series}<small class="compare-status">${status}</small></div></div>`;
  })
  .join("\n");

const estimate = estimateCosts(
  allocations.find((allocation) => allocation.name === imgtAllocation),
  costScenario,
);
const cf = estimate.cloudflare;
const costRows = [
  [
    "imgt",
    "imgt on Cloudflare",
    "1 CPU always on, 3 CPU for bursts",
    estimate.imgtTotal,
  ],
  ["vercel", "Vercel", "Image Optimization", estimate.vercelTotal],
];
const highest = Math.max(...costRows.map((row) => row[3])) * 1.02;
const costChart = costRows
  .map(
    ([id, name, detail, value]) =>
      `<div class="compare-bar cost ${id}"><span class="compare-name">${name}<small>${detail}</small></span>${bar(value, highest)}<span class="compare-value">${currency(value)}<small>per month</small></span></div>`,
  )
  .join("\n");
const lines = (title, total, items) =>
  `<div class="cost-list"><h3>${title}</h3><dl>${items
    .filter(([, value]) => value >= 0.005)
    .map(
      ([label, value]) =>
        `<div><dt>${label}</dt><dd>${currency(value)}</dd></div>`,
    )
    .join(
      "",
    )}<div class="cost-total"><dt>Total</dt><dd>${currency(total)}</dd></div></dl></div>`;
const costBreakdown =
  lines("imgt on Cloudflare", estimate.imgtTotal, [
    ["Workers Paid plan", cf.plan],
    ["Containers: memory, CPU, disk", cf.memory + cf.cpu + cf.disk],
    ["R2 storage and operations", cf.r2],
    ["Worker requests", cf.worker],
    ["Durable Objects", cf.objects],
    ["Output transfer", cf.transfer],
  ]) +
  lines("Vercel", estimate.vercelTotal, [
    ["Image transformations", estimate.vercel.transforms],
    ["Image cache writes", estimate.vercel.writes],
    ["Image cache reads", estimate.vercel.reads],
  ]);

// Headline cards are derived from the same data as the charts.
const same = rows.filter((row) => row.verdict.winner === "tie");
const behind = rows.filter((row) => row.verdict.winner === "vercel");
const around = (values) =>
  (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
const rates = same.map((row) => row.name.split(" ")[0]);
const summary = [
  [
    "Monthly cost",
    `${Math.round(estimate.vercelTotal / estimate.imgtTotal)}× cheaper`,
    `$${Math.round(estimate.imgtTotal)} vs $${Math.round(estimate.vercelTotal)} for ${(costScenario.transforms / 1e6).toFixed(2)}M new images.`,
    "good",
  ],
  [
    "Steady traffic",
    "Same speed",
    `About ${around(same.flatMap((row) => [row.values.imgt, row.values.vercel]))} s on both at ${rates.slice(0, -1).join(", ")} and ${rates.at(-1)} new images per second.`,
    "good",
  ],
  [
    "Big bursts",
    "Vercel is faster",
    `${behind.map((row) => `${row.values.imgt.toFixed(1)} s vs ${row.values.vercel.toFixed(1)} s for ${row.name.split(" ")[0]}`).join(", ")} new images at once.`,
    "warn",
  ],
  [
    "Repeat views",
    `${(cachedP95Ms / 1000).toFixed(1)} s`,
    "Images already made come straight from Cloudflare's cache.",
    "good",
  ],
]
  .map(
    ([label, value, detail, tone]) =>
      `<div class="summary-card ${tone}"><p class="summary-label">${label}</p><p class="summary-value">${value}</p><p class="summary-detail">${detail}</p></div>`,
  )
  .join("\n");

let benchmarks = await readFile(new URL("benchmarks.html", assets), "utf8");
benchmarks = benchmarks
  .replace("<!-- SUMMARY -->", summary)
  .replace("<!-- SPEED_CHART -->", speedChart)
  .replace("<!-- COST_CHART -->", costChart)
  .replace("<!-- COST_BREAKDOWN -->", costBreakdown);
await writeFile(new URL("benchmarks.html", assets), benchmarks);

// Hash each static JSON-LD block; keep inline executable scripts disabled.
const hashes = [html, benchmarks].flatMap((page) =>
  [
    ...page.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    ),
  ].map(
    (match) =>
      `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`,
  ),
);
const headers = await readFile(new URL("_headers", assets), "utf8");
await writeFile(
  new URL("_headers", assets),
  headers.replace("script-src 'self'", `script-src 'self' ${hashes.join(" ")}`),
);

const docs = (await readdir(new URL("docs/", root)))
  .filter((name) => name.endsWith(".md"))
  .sort();
const files = [
  ["README.md", "index.md"],
  ["CONTRIBUTING.md", "CONTRIBUTING.md"],
  ["LICENSE", "LICENSE"],
  ...docs.map((name) => [`docs/${name}`, `docs/${name}`]),
];

await mkdir(new URL("docs/", assets), { recursive: true });
const sections = [];
for (const [source, target] of files) {
  let body = await readFile(new URL(source, root), "utf8");
  // README asset links use repository paths on GitHub and site paths here.
  if (source === "README.md")
    body = "# imgt\n\n" + body.replace(/\]\(public\//g, "](/");
  await writeFile(new URL(target, assets), body);
  // Keep links usable from the combined document at the site root.
  const linked = body.replace(/\]\(([^\s)]+)\)/g, (match, href) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return match;
    const url = new URL(href, `https://docs.invalid/${target}`);
    return `](${url.pathname}${url.search}${url.hash})`;
  });
  sections.push(`<!-- Source: /${target} -->\n\n${linked.trim()}`);
}
await writeFile(
  new URL("llms-full.txt", assets),
  `# imgt documentation\n\nGenerated from the repository documentation.\n\n${sections.join("\n\n---\n\n")}\n`,
);
console.log(
  `Built the static site, ${files.length} documents and llms-full.txt.`,
);
