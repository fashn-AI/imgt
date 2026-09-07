const form = document.querySelector("#demo");
const controls = document.querySelector("#controls");
const width = document.querySelector("#width");
const button = document.querySelector("#optimize");
const preview = document.querySelector("#preview");
const label = document.querySelector("#image-label");
const status = document.querySelector("#status");
const output = document.querySelector("#output");
const source = preview.src;
let previewUrl;

controls.disabled = false;
width.addEventListener("change", () => {
  button.textContent = "Optimize image";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  controls.disabled = true;
  form.setAttribute("aria-busy", "true");
  output.hidden = true;
  status.dataset.error = "false";
  status.textContent = "Optimizing… The first request can take a few seconds.";
  let nextUrl;

  try {
    const url = new URL("/image", location.origin);
    url.search = new URLSearchParams({ url: source, w: width.value });
    const started = performance.now();
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob();
    const elapsed = Math.round(performance.now() - started);
    if (blob.type !== "image/webp") throw new Error("Expected a WebP image.");

    nextUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.src = nextUrl;
    await image.decode();
    preview.src = nextUrl;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = nextUrl;
    nextUrl = undefined;

    const cache = response.headers.get("x-imgt-cache");
    const delivery = {
      EDGE: "Edge cache",
      R2: "Storage cache",
      STALE: "Cached image, refreshing",
      MISS: "New transform",
    }[cache];
    label.textContent = `${image.naturalWidth} × ${image.naturalHeight} · WebP`;
    status.textContent = `${(blob.size / 1024).toFixed(1)} KiB · ${elapsed} ms${delivery ? ` · ${delivery}` : ""}. Run again to try the cache.`;
    output.href = url.href;
    output.hidden = false;
    button.textContent = "Run again";
  } catch (error) {
    status.dataset.error = "true";
    status.textContent = `Could not optimize: ${error.message}. Try again.`;
  } finally {
    if (nextUrl) URL.revokeObjectURL(nextUrl);
    controls.disabled = false;
    form.removeAttribute("aria-busy");
  }
});
