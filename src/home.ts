import { config } from "../imgt.config";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

export function homeResponse(
  request: Request,
  allowedHosts: readonly string[],
): Response {
  const nonce = crypto.randomUUID();
  const origin = new URL(request.url).origin;
  const demo = allowedHosts.includes("images.unsplash.com")
    ? "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&w=1920&q=90"
    : "";
  const loader = `'use client';

export default function imageLoader({ src, width, quality = ${config.transforms.defaultQuality} }) {
  const query = new URLSearchParams({ url: src, w: String(width), q: String(quality) });
  return ${JSON.stringify(origin + "/image?")} + query;
}`;
  return new Response(
    /* HTML */ `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>imgt · Your image endpoint</title>
          <style nonce="${nonce}">
            :root {
              color-scheme: light;
              --ink: #202722;
              --muted: #637068;
              --line: #dce2da;
              --paper: #f5f7f1;
              --green: #246c44;
            }
            * {
              box-sizing: border-box;
            }
            body {
              margin: 0;
              background: var(--paper);
              color: var(--ink);
              font:
                16px/1.55 system-ui,
                sans-serif;
            }
            main {
              max-width: 1080px;
              margin: auto;
              padding: 36px 28px 72px;
            }
            header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              border-bottom: 1px solid var(--line);
              padding-bottom: 22px;
            }
            .brand {
              font-size: 28px;
              font-weight: 750;
              letter-spacing: -1.4px;
            }
            .tag {
              font-size: 13px;
              color: var(--muted);
            }
            .status {
              font-size: 13px;
              border: 1px solid var(--line);
              border-radius: 30px;
              padding: 7px 12px;
              background: white;
            }
            h1 {
              font-size: clamp(34px, 6vw, 54px);
              line-height: 1.12;
              letter-spacing: -2px;
              margin: 48px 0 15px;
              max-width: 680px;
            }
            h2 {
              font-size: 20px;
              letter-spacing: -0.4px;
              margin: 0 0 18px;
            }
            p {
              color: var(--muted);
              margin: 0 0 22px;
            }
            .endpoint {
              font:
                14px ui-monospace,
                monospace;
              overflow-wrap: anywhere;
            }
            .grid {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 22px;
              margin: 32px 0;
            }
            .card {
              background: white;
              border: 1px solid var(--line);
              border-radius: 14px;
              padding: 26px;
              min-width: 0;
            }
            label {
              display: block;
              font-size: 13px;
              font-weight: 650;
              margin-bottom: 7px;
            }
            input,
            select,
            textarea,
            button {
              font: inherit;
            }
            input,
            select,
            textarea {
              width: 100%;
              border: 1px solid var(--line);
              border-radius: 7px;
              background: var(--paper);
              color: var(--ink);
              padding: 10px 12px;
            }
            input {
              font-size: 14px;
            }
            .row {
              display: flex;
              gap: 14px;
              margin: 16px 0;
            }
            .row > div {
              flex: 1;
            }
            button {
              border: 0;
              border-radius: 7px;
              padding: 11px 17px;
              background: var(--green);
              color: white;
              cursor: pointer;
              font-size: 14px;
              font-weight: 600;
            }
            button:disabled {
              opacity: 0.55;
              cursor: wait;
            }
            button.secondary {
              background: var(--paper);
              color: var(--ink);
              border: 1px solid var(--line);
            }
            button:focus-visible,
            input:focus-visible,
            select:focus-visible,
            textarea:focus-visible {
              outline: 3px solid #91bb9f;
              outline-offset: 2px;
            }
            .small {
              font-size: 13px;
            }
            .note {
              margin: 14px 0 0;
              font-size: 13px;
            }
            .result {
              min-height: 245px;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              background: var(--paper);
              border: 1px dashed var(--line);
              border-radius: 8px;
              padding: 18px;
              text-align: center;
            }
            .result img {
              display: block;
              max-height: 300px;
              max-width: 100%;
              border-radius: 5px;
            }
            .result img[hidden] {
              display: none;
            }
            .result p {
              margin: 10px 0 0;
              font-size: 13px;
            }
            #result-message {
              white-space: pre-line;
              overflow-wrap: anywhere;
            }
            #metrics {
              font:
                12px/1.6 ui-monospace,
                monospace;
              color: var(--muted);
              margin-top: 14px;
              white-space: pre-wrap;
            }
            textarea {
              font:
                12px/1.6 ui-monospace,
                monospace;
              resize: vertical;
              min-height: 180px;
              white-space: pre;
            }
            pre {
              white-space: pre-wrap;
              overflow-wrap: anywhere;
              font:
                12px/1.7 ui-monospace,
                monospace;
              background: var(--paper);
              padding: 16px;
              border-radius: 8px;
            }
            .copy-row {
              display: flex;
              align-items: center;
              gap: 12px;
              margin-top: 12px;
            }
            a {
              color: var(--green);
            }
            footer {
              font-size: 13px;
              color: var(--muted);
              margin-top: 30px;
            }
            code {
              font-family: ui-monospace, monospace;
              font-size: 0.9em;
            }
            .allowed {
              overflow-wrap: anywhere;
              margin-top: 18px;
            }
            @media (max-width: 720px) {
              main {
                padding: 24px 18px 48px;
              }
              .grid {
                grid-template-columns: 1fr;
              }
              .card {
                padding: 20px;
              }
              .tag {
                display: none;
              }
              h1 {
                margin-top: 34px;
              }
            }
          </style>
        </head>
        <body>
          <main>
            <header>
              <div>
                <span class="brand">imgt</span>
                <span class="tag"> / self-hosted image optimization</span>
              </div>
              <span class="status" id="status">Worker reachable</span>
            </header>
            <h1>Your images.<br />Your Cloudflare account.</h1>
            <p>
              Resize and serve WebP images through your own cached endpoint.
            </p>
            <div class="endpoint">${escapeHtml(origin)}/image</div>
            <div class="grid">
              <section class="card">
                <h2>1. Try an image</h2>
                <form id="test-form">
                  <label for="source">Public HTTPS image URL</label
                  ><input
                    id="source"
                    name="source"
                    type="url"
                    required
                    placeholder="https://cdn.example.com/photo.jpg"
                    value="${escapeHtml(demo)}"
                  />
                  <div class="row">
                    <div>
                      <label for="width">Width</label
                      ><select id="width">
                        ${config.transforms.widths.map((width) => `<option${width === 640 ? " selected" : ""}>${width}</option>`).join("")}
                      </select>
                    </div>
                    <div>
                      <label for="quality">Quality</label
                      ><select id="quality">
                        ${config.transforms.qualities.map((quality) => `<option${quality === config.transforms.defaultQuality ? " selected" : ""}>${quality}</option>`).join("")}
                      </select>
                    </div>
                  </div>
                  <button type="submit" id="test-button">
                    Test image &amp; cache
                  </button>
                </form>
                <p class="note">
                  Runs a transform, repeats it to check the cache, then checks
                  the ETag. First requests may take longer while a container
                  starts.
                </p>
                <p class="small allowed">
                  <strong>Allowed hosts:</strong>
                  ${allowedHosts.length ? allowedHosts.map(escapeHtml).join(", ") : "None configured."}
                </p>
                <p class="small">
                  Set <code>vars.ALLOWED_HOSTS</code> in your repository’s
                  <code>wrangler.jsonc</code> to your image hosts, then push to
                  your production branch. Separate hosts with commas;
                  <code>*.example.com</code> allows subdomains.
                </p>
              </section>
              <section class="card">
                <h2>Deployment check</h2>
                <div class="result" aria-live="polite">
                  <img id="preview" alt="Transformed image preview" hidden />
                  <p id="result-message">
                    Run the image test to verify the transformer and cache.
                  </p>
                </div>
                <div id="metrics"></div>
              </section>
            </div>
            <section class="card">
              <h2>2. Connect Next.js</h2>
              <p class="small">
                Save this as <code>image-loader.js</code>. Pass absolute source
                URLs from your allowed hosts to <code>next/image</code>.
              </p>
              <label for="loader">Image loader</label
              ><textarea id="loader" readonly spellcheck="false">
${escapeHtml(loader)}</textarea>
              <div class="copy-row">
                <button class="secondary" id="copy">Copy loader</button
                ><span class="small" id="copy-status" aria-live="polite"></span>
              </div>
              <p class="note">Add the loader to <code>next.config.js</code>:</p>
              <pre>
export default {
  images: {
    loader: 'custom',
    loaderFile: './image-loader.js',
    qualities: [${config.transforms.qualities.join(", ")}],
  },
};</pre>
            </section>
            <footer>
              <a href="https://github.com/relferreira/imgt"
                >Source &amp; documentation</a
              >
              · MIT licensed · Images remain in your Cloudflare account. This
              page changes no configuration.
            </footer>
          </main>
          <script nonce="${nonce}">
            const byId = (id) => document.getElementById(id);
            let previewUrl;
            byId("copy").addEventListener("click", async () => {
              try {
                await navigator.clipboard.writeText(byId("loader").value);
                byId("copy-status").textContent = "Copied";
              } catch {
                byId("loader").select();
                byId("copy-status").textContent =
                  "Select and copy the loader above.";
              }
            });
            byId("test-form").addEventListener("submit", async (event) => {
              event.preventDefault();
              const button = byId("test-button");
              button.disabled = true;
              const status = byId("status");
              status.textContent = "Checking deployment…";
              byId("result-message").textContent = "Transforming image…";
              byId("metrics").textContent = "";
              byId("preview").hidden = true;
              try {
                const url = new URL("/image", location.origin);
                url.search = new URLSearchParams({
                  url: byId("source").value,
                  w: byId("width").value,
                  q: byId("quality").value,
                });
                const start = performance.now();
                const response = await fetch(url, {
                  cache: "no-store",
                  signal: AbortSignal.timeout(30000),
                });
                if (!response.ok)
                  throw new Error(
                    "HTTP " + response.status + ": " + (await response.text()),
                  );
                const blob = await response.blob();
                if (blob.type !== "image/webp")
                  throw new Error("Expected a WebP image.");
                const elapsed = Math.round(performance.now() - start);
                if (previewUrl) URL.revokeObjectURL(previewUrl);
                previewUrl = URL.createObjectURL(blob);
                const preview = byId("preview");
                preview.src = previewUrl;
                await preview.decode();
                preview.hidden = false;
                byId("result-message").textContent =
                  "Image ready. Checking cache…";
                const cachedAt = performance.now();
                const repeat = await fetch(url, {
                  cache: "no-store",
                  signal: AbortSignal.timeout(30000),
                });
                const repeated = await repeat.arrayBuffer();
                if (!repeat.ok)
                  throw new Error(
                    "Repeat request returned HTTP " + repeat.status,
                  );
                const cachedMs = Math.round(performance.now() - cachedAt);
                const etag = response.headers.get("etag");
                if (
                  !etag ||
                  repeat.headers.get("etag") !== etag ||
                  repeated.byteLength !== blob.size
                )
                  throw new Error("Repeated image did not match.");
                const conditional = await fetch(url, {
                  cache: "no-store",
                  headers: { "If-None-Match": etag },
                  signal: AbortSignal.timeout(30000),
                });
                await conditional.arrayBuffer();
                if (conditional.status !== 304)
                  throw new Error(
                    "ETag check returned HTTP " + conditional.status,
                  );
                const cache = repeat.headers.get("x-imgt-cache");
                status.textContent =
                  cache === "EDGE"
                    ? "Deployment verified"
                    : "Image & ETag verified";
                byId("result-message").textContent =
                  cache === "EDGE"
                    ? "Transform, edge cache, and ETag checks passed."
                    : "Image and ETag passed. Repeat path: " +
                      cache +
                      ". Edge cache is not confirmed yet.";
                byId("metrics").textContent =
                  preview.naturalWidth +
                  " × " +
                  preview.naturalHeight +
                  " · " +
                  (blob.size / 1024).toFixed(1) +
                  " KiB WebP\\nFirst: " +
                  elapsed +
                  " ms (" +
                  response.headers.get("x-imgt-cache") +
                  ")\\nRepeat: " +
                  cachedMs +
                  " ms (" +
                  cache +
                  ") · Conditional: 304";
              } catch (error) {
                status.textContent = "Check needs attention";
                byId("result-message").textContent = error.message;
              } finally {
                button.disabled = false;
              }
            });
          </script>
        </body>
      </html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    },
  );
}
