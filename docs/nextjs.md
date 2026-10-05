# Next.js

Use imgt as the optimizer for `next/image`. Next.js generates responsive image
URLs; the browser requests them from your imgt deployment. Configure these three
files in your Next.js project, replacing the endpoint with your own.
The endpoint in these examples is a placeholder. Deploy your own instance;
the FASHN AI demonstration website is not a shared optimization service.

For agent-assisted setup, use the [setup prompt](setup-prompt.md).

## Configure the loader

Merge this `images` configuration into `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    loader: "custom",
    loaderFile: "./image-loader.ts",
    qualities: [77],
  },
};

export default nextConfig;
```

Set `images.qualities` to the values your Next.js components use; this example
uses 77. imgt accepts any integer from 1 to 100, and the custom loader forwards
the requested value.

Create `image-loader.ts` at the project root:

```ts
"use client";

import type { ImageLoaderProps } from "next/image";

export default function imageLoader({
  src,
  width,
  quality = 77,
}: ImageLoaderProps) {
  const url = new URL("/image", "https://imgt.YOUR-SUBDOMAIN.workers.dev");
  url.search = new URLSearchParams({
    url: src,
    w: String(width),
    q: String(quality),
  }).toString();
  return url.href;
}
```

The loader has a client boundary, as required by Next.js; the page can remain a
Server Component because `loaderFile` configures `Image` without passing a
function prop. See the [Next.js custom loader documentation](https://nextjs.org/docs/app/api-reference/config/next-config-js/images).

## Render an image

Use this in `app/page.tsx` (or `src/app/page.tsx`):

```tsx
import Image from "next/image";

export default function Page() {
  return (
    <main style={{ maxWidth: 800, margin: "0 auto" }}>
      <Image
        src="https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&fit=crop&w=1920&h=1200&q=90"
        alt="Landscape from Unsplash"
        width={1920}
        height={1200}
        quality={77}
        sizes="(max-width: 768px) 100vw, 800px"
        style={{ width: "100%", height: "auto" }}
      />
    </main>
  );
}
```

Keep `images.unsplash.com` in imgt's `ALLOWED_HOSTS` for this example. For your
images, allow their source hosts and use publicly accessible HTTPS URLs. Your
Next.js domain needs to be listed only if it hosts the originals; see
[source host configuration](configuration.md#allowed-source-hosts).
`remotePatterns` is not needed for this custom loader; imgt enforces its own
allowlist before fetching sources.

imgt accepts any integer width from 1 to 3840 pixels, including Next.js's default
responsive sizes. `quality={77}` makes the chosen quality explicit, and the loader
uses 77 when quality is omitted. Each width and quality combination creates its
own cached derivative. Set `sizes` to the image's actual CSS layout so browsers
choose an appropriate width. See the
[Next.js Image reference](https://nextjs.org/docs/app/api-reference/components/image).

## Local assets

Paths such as `/photo.jpg` and static imports resolve to app-relative URLs.
imgt needs an absolute HTTPS URL it can reach; `localhost` is not a valid source.
To serve files from `public/` or built static imports, resolve `src` against your
public app origin in the loader, replacing `url: src` with:

```ts
url: new URL(src, "https://www.example.com").href,
```

Add `www.example.com` to imgt's `ALLOWED_HOSTS` and ensure that URL is deployed
and publicly accessible. During local development, use an already deployed
source or let Next.js serve a local image directly with `unoptimized`.
