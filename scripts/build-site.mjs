import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createHighlighter } from "shiki";

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
// Allow only this static structured-data block without enabling inline scripts.
const structuredData = html.match(
  /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
)[1];
const hash = createHash("sha256").update(structuredData).digest("base64");
const headers = await readFile(new URL("_headers", assets), "utf8");
await writeFile(
  new URL("_headers", assets),
  headers.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`),
);
await writeFile(new URL("index.html", assets), html);
await writeFile(
  new URL("syntax.css", assets),
  [...styles].map(([style, name]) => `.${name}{${style}}`).join("\n") + "\n",
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
