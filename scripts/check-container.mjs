import { execFileSync, spawnSync } from "node:child_process";

const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();
const image = process.env.IMGT_CONTAINER_IMAGE || "imgt-container-check";
const testImage = process.env.IMGT_TEST_IMAGE || "imgt-container-check-delay";
for (const [tag, features] of [
  [image, ""],
  [testImage, "test-delay"],
]) {
  if (!process.env.IMGT_CONTAINER_IMAGE) {
    execFileSync(
      "docker",
      [
        "build",
        "-t",
        tag,
        "--build-arg",
        `IMGT_TEST_FEATURES=${features}`,
        "container",
      ],
      { stdio: "inherit" },
    );
  }
}
const name = `imgt-container-check-${process.pid}`;
try {
  docker("run", "-d", "--name", name, "-p", "127.0.0.1::8080", image);
  const port = docker("port", name, "8080/tcp").split(":").at(-1);
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await fetch(`${endpoint}/health`)).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("Container did not become healthy");
  const env = {
    ...process.env,
    IMGT_CONTAINER_URL: endpoint,
    IMGT_CONTAINER_IMAGE: image,
    IMGT_TEST_IMAGE: testImage,
  };
  for (const file of [
    "test/transforms.test.ts",
    "test/container.integration.mjs",
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--test", file],
      { env, stdio: "inherit" },
    );
    if (result.status !== 0)
      throw new Error(`Container regression checks failed: ${file}`);
  }
} finally {
  docker("rm", "-f", name);
}
