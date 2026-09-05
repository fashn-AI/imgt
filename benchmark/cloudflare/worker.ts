// Isolated container experiment. Only fixed public fixtures are accepted.
// This Worker has no R2, user credentials or arbitrary-source endpoint.
import { Container, getContainer } from "@cloudflare/containers";
interface Env { LIMITER: RateLimit; LAB: DurableObjectNamespace<EngineLab> }
const ports = { sharp: 8080, native: 8081, "native-e4": 8082, "sharp-e4": 8083 };
export class EngineLab extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = false;
  fetch(request: Request) {
    const engine = new URL(request.url).searchParams.get("engine") as keyof typeof ports;
    return this.containerFetch(request, ports[engine] ?? 8080);
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("not found",{status:404});
    if(url.pathname === "/health") return Response.json({ok:true,engines:Object.keys(ports)});
    if(url.pathname !== "/image") return new Response("not found",{status:404});
    if(!(await env.LIMITER.limit({key:request.headers.get("cf-connecting-ip")??"local"})).success)
      return new Response("rate limited",{status:429,headers:{"retry-after":"60"}});
    const width=Number(url.searchParams.get("w"));
    const quality=Number(url.searchParams.get("q")??77);
    const engine=url.searchParams.get("engine")??"sharp";
    if(![640,1920,3840].includes(width)||![75,77].includes(quality)||!Object.hasOwn(ports,engine)) return new Response("invalid options",{status:400});
    const started=performance.now();
    try {
      const source=await fetch("https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&q=90&w=3840",{signal:AbortSignal.timeout(15000)});
      if(!source.ok||!source.body) return new Response("source failed",{status:502});
      const originMs=performance.now()-started;
        const response=await getContainer(env.LAB,"engine-comparison").fetch(new Request(
          `http://container/transform?w=${width}&q=${quality}&engine=${engine}`,{
            method:"POST",body:source.body,headers:{"x-imgt-deadline":String(Date.now()+20000)},signal:AbortSignal.timeout(20000)
          }));
        const body=await response.arrayBuffer();
        return new Response(body,{status:response.status,headers:{"content-type":response.headers.get("content-type")??"text/plain",
          "cache-control":"no-store","x-benchmark-engine":engine,
          "x-benchmark-build":response.headers.get("x-benchmark-build")??"initial",
          "server-timing":`origin_headers;dur=${originMs.toFixed(1)}, ${response.headers.get("server-timing")??""}, total;dur=${(performance.now()-started).toFixed(1)}`}});
    } catch(e) {console.error(e);return new Response("benchmark transform failed",{status:502});}
  }
} satisfies ExportedHandler<Env>;
