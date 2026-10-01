import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// Do the same type stripping Node performs at startup, once during the build.
await mkdir("dist", { recursive: true });
for (const file of await readdir(".")) {
  if (!file.endsWith(".ts")) continue;
  const code = stripTypeScriptTypes(await readFile(file, "utf8"));
  const javascript = code.replace(
    /(\b(?:from|import)\s*["']\.[^"']*)\.ts(["'])/g,
    "$1.js$2",
  );
  await writeFile(`dist/${file.slice(0, -3)}.js`, javascript);
}
