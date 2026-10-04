import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";

const root = new URL("../", import.meta.url);
const docs = (await readdir(new URL("docs/", root)))
  .filter((name) => name.endsWith(".md"))
  .sort();
const files = [
  ["README.md", "index.md"],
  ["CONTRIBUTING.md", "CONTRIBUTING.md"],
  ["LICENSE", "LICENSE"],
  ...docs.map((name) => [`docs/${name}`, `docs/${name}`]),
];

await rm(new URL("public/docs/", root), { recursive: true, force: true });
await mkdir(new URL("public/docs/", root), { recursive: true });
const sections = [];
for (const [source, target] of files) {
  await copyFile(new URL(source, root), new URL(`public/${target}`, root));
  const body = await readFile(new URL(source, root), "utf8");
  // Keep links usable from the combined document at the site root.
  const linked = body.replace(/\]\(([^\s)]+)\)/g, (match, href) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return match;
    const url = new URL(href, `https://docs.invalid/${target}`);
    return `](${url.pathname}${url.search}${url.hash})`;
  });
  sections.push(`<!-- Source: /${target} -->\n\n${linked.trim()}`);
}
await writeFile(
  new URL("public/llms-full.txt", root),
  `# imgt documentation\n\nGenerated from the repository documentation.\n\n${sections.join("\n\n---\n\n")}\n`,
);
console.log(`Published ${files.length} documents and llms-full.txt.`);
