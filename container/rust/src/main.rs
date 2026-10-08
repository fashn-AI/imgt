mod native;
const RENDERER_VERSION: &str = env!("IMGT_RENDERER_VERSION");
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    response::{IntoResponse, Response},
    routing::{get, post},
    serve::ListenerExt,
    Router,
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{timeout_at, Instant},
};
fn millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn setting(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .map(|v| v.parse::<usize>().expect(key))
        .unwrap_or(default)
}
struct App {
    admission: Arc<Semaphore>,
    encoders: Arc<Semaphore>,
    uploading: Arc<AtomicUsize>,
    queued: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    max_inflight: usize,
    max_bytes: usize,
    timeout_ms: u64,
    effort: i32,
}
struct Counter(Arc<AtomicUsize>);
impl Counter {
    fn new(v: Arc<AtomicUsize>) -> Self {
        v.fetch_add(1, Ordering::SeqCst);
        Self(v)
    }
}
impl Drop for Counter {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
struct CancelOnDrop(Arc<native::Control>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
fn error(status: u16, message: impl Into<String>) -> Response {
    let mut r = Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("cache-control", "no-store")
        .header("connection", "close");
    if status == 429 {
        r = r.header("retry-after", "1");
    }
    r.body(Body::from(message.into())).unwrap()
}
async fn health(State(s): State<Arc<App>>) -> Response {
    axum::Json(serde_json::json!({"ok":true,"active":s.active.load(Ordering::SeqCst)>0,"queued":s.queued.load(Ordering::SeqCst),"uploading":s.uploading.load(Ordering::SeqCst),"inFlight":s.max_inflight-s.admission.available_permits(),"activeCount":s.active.load(Ordering::SeqCst)})).into_response()
}
async fn transform(State(s): State<Arc<App>>, request: Request) -> Response {
    let query: std::collections::HashMap<String, String> =
        match axum::extract::Query::try_from_uri(request.uri()) {
            Ok(v) => v.0,
            Err(_) => return error(400, "invalid parameters"),
        };
    let width = match query.get("w").and_then(|v| v.parse::<i32>().ok()) {
        Some(w) if (1..=3840).contains(&w) => w,
        _ => return error(400, "invalid width"),
    };
    let quality = match query.get("q").and_then(|v| v.parse::<i32>().ok()) {
        Some(q) if (1..=100).contains(&q) => q,
        _ => return error(400, "invalid quality"),
    };
    let requested = match request
        .headers()
        .get("x-imgt-deadline")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        Some(d) if d > 0 && d <= 9_007_199_254_740_991 => d,
        _ => return error(400, "invalid transform deadline"),
    };
    let now = millis();
    let deadline = requested.min(now + s.timeout_ms);
    if deadline <= now {
        return error(504, "image transformation timed out");
    }
    if request
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|v| v > s.max_bytes as u64)
    {
        return error(413, "input too large");
    }
    let admission = match s.admission.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => return error(429, "transform queue is full"),
    };
    let until = Instant::now() + Duration::from_millis(deadline - now);
    let control = Arc::new(native::Control::default());
    let _cancel = CancelOnDrop(control.clone());
    let upload_start = Instant::now();
    let uploading = Counter::new(s.uploading.clone());
    let input = match timeout_at(until, to_bytes(request.into_body(), s.max_bytes)).await {
        Ok(Ok(b)) if !b.is_empty() => b,
        Ok(Ok(_)) => return error(400, "empty input"),
        Ok(Err(e)) => {
            let too_large = std::error::Error::source(&e)
                .is_some_and(|e| e.is::<http_body_util::LengthLimitError>());
            return error(if too_large { 413 } else { 400 }, e.to_string());
        }
        Err(_) => return error(504, "image transformation timed out"),
    };
    drop(uploading);
    let input_ms = upload_start.elapsed().as_secs_f64() * 1000.;
    let queued_at = Instant::now();
    let queued = Counter::new(s.queued.clone());
    let slot = match timeout_at(until, s.encoders.clone().acquire_owned()).await {
        Ok(Ok(p)) => p,
        _ => return error(504, "image transformation timed out"),
    };
    drop(queued);
    let queue_ms = queued_at.elapsed().as_secs_f64() * 1000.;
    let native_start = Instant::now();
    let native_control = control.clone();
    let active = s.active.clone();
    let effort = s.effort;
    #[cfg(feature = "test-delay")]
    let test_delay = setting("IMGT_TEST_RENDER_DELAY_MS", 0);
    let mut job = tokio::task::spawn_blocking(move || {
        let dispatch_ms = native_start.elapsed().as_secs_f64() * 1000.;
        let _slot: OwnedSemaphorePermit = slot;
        let _admission: OwnedSemaphorePermit = admission;
        let _active = Counter::new(active);
        #[cfg(feature = "test-delay")]
        if test_delay > 0 {
            std::thread::sleep(Duration::from_millis(test_delay as u64));
        }
        (
            native::encode(input, width, quality, effort, &native_control),
            dispatch_ms,
        )
    });
    match timeout_at(until, &mut job).await {
        Ok(Ok((Ok(output), dispatch_ms))) => Response::builder()
            .status(200)
            .header("content-type", "image/webp")
            .header("content-length", output.data.len())
            .header("x-imgt-renderer", RENDERER_VERSION)
            .header(
                "server-timing",
                format!(
                    "source_body;dur={input_ms:.1}, queue;dur={queue_ms:.1}, encode;dur={:.1}, native_dispatch;dur={dispatch_ms:.3}, native_prepare;dur={:.3}, native_encode;dur={:.3}, native_output;dur={:.3}",
                    native_start.elapsed().as_secs_f64() * 1000., output.prepare_ms, output.encode_ms, output.output_ms
                ),
            )
            .body(Body::from(output.data))
            .unwrap(),
        Ok(Ok((Err(e), _))) => error(400, e),
        Ok(Err(e)) => error(500, e.to_string()),
        Err(_) => {
            control.cancel();
            error(504, "image transformation timed out")
        }
    }
}
fn main() {
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.worker_threads(1).enable_all();
    builder.max_blocking_threads(setting("TRANSFORM_CONCURRENCY", 2));
    builder.build().unwrap().block_on(run());
}
async fn run() {
    let start = Instant::now();
    let vips = native::initialize().expect("libvips initialization");
    let max_inflight = setting("MAX_IN_FLIGHT", 8);
    let concurrency = setting("TRANSFORM_CONCURRENCY", 2);
    let timeout_ms = setting("TRANSFORM_TIMEOUT_MS", 60000) as u64;
    let effort = setting("WEBP_EFFORT", 4);
    assert!(max_inflight > 0 && concurrency > 0 && timeout_ms > 0 && effort <= 6);
    let state = Arc::new(App {
        admission: Arc::new(Semaphore::new(max_inflight)),
        encoders: Arc::new(Semaphore::new(concurrency)),
        uploading: Arc::new(AtomicUsize::new(0)),
        queued: Arc::new(AtomicUsize::new(0)),
        active: Arc::new(AtomicUsize::new(0)),
        max_inflight,
        max_bytes: setting("MAX_INPUT_BYTES", 100 * 1024 * 1024),
        timeout_ms,
        effort: effort as i32,
    });
    let router = Router::new()
        .route("/health", get(health))
        .route("/transform", post(transform))
        .fallback(|| async { error(404, "not found") })
        .method_not_allowed_fallback(|| async { error(404, "not found") })
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", setting("PORT", 8080)))
        .await
        .unwrap();
    println!(
        "{}",
        serde_json::json!({"event":"container_listening","processUptimeMs":start.elapsed().as_millis(),"port":listener.local_addr().unwrap().port(),"renderer":RENDERER_VERSION,"vips":vips})
    );
    let shutdown = async move {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        tokio::select! {_=term.recv()=>{},_=tokio::signal::ctrl_c()=>{}};
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(timeout_ms + 1000)).await;
            std::process::exit(1);
        });
    };
    let listener = listener.tap_io(|stream| {
        stream.set_nodelay(true).unwrap();
    });
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await
        .unwrap();
    while state.admission.available_permits() != max_inflight {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    native::shutdown();
}
