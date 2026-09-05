// Isolated managed-engine experiment. Only fixed public fixtures are accepted.
// This Worker has no container, R2, user credentials or arbitrary-source endpoint.
interface Env { IMAGES: ImagesBinding; LIMITER: RateLimit }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("not found",{status:404});
    if(url.pathname === "/health") return Response.json({ok:true,engine:"cloudflare-images"});
    if(url.pathname !== "/image") return new Response("not found",{status:404});
    if(!(await env.LIMITER.limit({key:request.headers.get("cf-connecting-ip")??"local"})).success)
      return new Response("rate limited",{status:429,headers:{"retry-after":"60"}});
    const width=Number(url.searchParams.get("w"));
    const quality=Number(url.searchParams.get("q")??77);
    if(![640,1920,3840].includes(width)||![75,77].includes(quality)) return new Response("invalid options",{status:400});
    const started=performance.now();
    try {
      const source=await fetch("https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&q=90&w=3840",{signal:AbortSignal.timeout(15000)});
      if(!source.ok||!source.body) return new Response("source failed",{status:502});
      const originMs=performance.now()-started;
      const result=await env.IMAGES.input(source.body).transform({width,fit:"scale-down"}).output({format:"image/webp",quality});
      const body=await result.response().arrayBuffer();
      return new Response(body,{headers:{"content-type":"image/webp","cache-control":"no-store",
        "server-timing":`origin_headers;dur=${originMs.toFixed(1)}, images;dur=${(performance.now()-started-originMs).toFixed(1)}`,
        "x-benchmark-engine":"cloudflare-images"}});
    } catch(e) {console.error(e);return new Response("managed transform failed",{status:502});}
  }
} satisfies ExportedHandler<Env>;
