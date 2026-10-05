import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createHighlighter } from "shiki";
import {
  allocations,
  defaultScenario,
  estimateCosts,
} from "../public/benchmark-costs.js";

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
const chart = (labels, values, format) => {
  const maximum = Math.max(1, ...values) * 1.05;
  return labels
    .map(
      (label, i) =>
        `<div class="chart-row${label === "Vercel" ? " vercel" : ""}"><span>${label}</span><svg viewBox="0 0 1000 24" preserveAspectRatio="none" aria-hidden="true"><rect width="${(values[i] / maximum) * 1000}" height="24" rx="2" /></svg><span class="chart-value">${format(values[i])}</span></div>`,
    )
    .join("\n");
};
const costs = allocations.map((allocation) =>
  estimateCosts(allocation, defaultScenario),
);
const components = {
  plan: "Workers plan",
  memory: "Container memory",
  cpu: "Active container CPU",
  disk: "Container disk",
  objects: "Durable Objects",
  r2: "R2 storage and operations",
  worker: "Workers usage",
  transfer: "Container output transfer",
  total: "Modeled subtotal",
};
let benchmarks = await readFile(new URL("benchmarks.html", assets), "utf8");
benchmarks = benchmarks
  .replace(
    "<!-- LATENCY_CHART -->",
    chart(
      ["imgt · 4 × 2 CPUs", "imgt · 8 × 1 CPU", "imgt · 2 × 1 CPU", "Vercel"],
      [1.755, 2.637, 4.201, 1.377],
      (value) => `${value.toFixed(3)} s`,
    ),
  )
  .replace(
    "<!-- COST_CHART -->",
    chart(
      [
        ...allocations.map((allocation) => `imgt · ${allocation.name}`),
        "Vercel",
      ],
      [...costs.map((cost) => cost.imgtTotal), costs[0].vercelTotal],
      currency,
    ),
  )
  .replace(
    "<!-- COST_BREAKDOWN -->",
    Object.entries(components)
      .map(
        ([key, label]) =>
          `<tr data-component="${key}"><th scope="row">${label}</th>${costs.map((cost) => `<td>${currency(key === "total" ? cost.imgtTotal : cost.cloudflare[key])}</td>`).join("")}</tr>`,
      )
      .join("\n"),
  );
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
