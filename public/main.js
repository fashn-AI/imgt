const form = document.querySelector("#demo");
const controls = document.querySelector("#controls");
const width = document.querySelector("#width");
const quality = document.querySelector("#quality");
const button = document.querySelector("#optimize");
const preview = document.querySelector("#preview");
const label = document.querySelector("#image-label");
const status = document.querySelector("#status");
const output = document.querySelector("#output");
const source = preview.src;
let previewUrl;
let originalBytes;
let optimizedBytes;
const originalSize = document.querySelector("#original-size");
const optimizedSize = document.querySelector("#optimized-size");
const sizeChange = document.querySelector("#size-change");
const formatSize = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

function showSizes() {
  if (originalBytes) originalSize.textContent = formatSize(originalBytes);
  if (optimizedBytes) optimizedSize.textContent = formatSize(optimizedBytes);
  if (originalBytes && optimizedBytes) {
    const reduction = 100 * (1 - optimizedBytes / originalBytes);
    sizeChange.textContent = `${Math.abs(reduction).toFixed(1)}% ${reduction >= 0 ? "smaller" : "larger"}`;
  }
}

// Measure the original without downloading its body a second time.
fetch(source, { method: "HEAD", signal: AbortSignal.timeout(10000) })
  .then((response) => {
    const bytes = Number(response.headers.get("content-length"));
    if (!response.ok || !Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error("Original size is unavailable");
    originalBytes = bytes;
    showSizes();
  })
  .catch(() => {
    originalSize.textContent = "Unavailable";
  });

for (const copy of document.querySelectorAll("[data-copy]")) {
  copy.disabled = false;
  copy.addEventListener("click", async () => {
    copy.disabled = true;
    const filename = copy.getAttribute("aria-label").replace("Copy ", "");
    const copyStatus = copy
      .closest("section")
      .querySelector(":scope > [data-copy-status]");
    copyStatus.dataset.error = "false";
    copyStatus.textContent = `Copying ${filename}…`;
    try {
      await navigator.clipboard.writeText(
        document.getElementById(copy.dataset.copy).textContent,
      );
      copyStatus.textContent = `Copied ${filename}.`;
    } catch {
      copyStatus.dataset.error = "true";
      copyStatus.textContent = `Could not copy ${filename}. Select the code and copy it manually.`;
    } finally {
      copy.disabled = false;
    }
  });
}

controls.disabled = false;
controls.addEventListener("change", () => {
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
    url.search = new URLSearchParams({
      url: source,
      w: width.value,
      q: quality.value,
    });
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
    optimizedBytes = blob.size;
    showSizes();

    const cache = response.headers.get("x-imgt-cache");
    const delivery = {
      EDGE: "Edge cache",
      R2: "Storage cache",
      STALE: "Cached image, refreshing",
      MISS: "New transform",
    }[cache];
    label.textContent = `${image.naturalWidth} × ${image.naturalHeight} · WebP`;
    status.textContent = `${image.naturalWidth} px · Quality ${quality.value} · ${elapsed} ms${delivery ? ` · ${delivery}` : ""}. Run again to try the cache.`;
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
