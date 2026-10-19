//! Local research instrumentation; absent when the feature is disabled.
use std::cell::RefCell;
use std::time::Instant;
std::thread_local! { static TIMES: RefCell<[(u128, u64); 8]> = const { RefCell::new([(0, 0); 8]) }; }
pub(crate) struct Scope { id: usize, start: Instant }
impl Scope { pub(crate) fn new(id: usize) -> Self { Self { id, start: Instant::now() } } }
impl Drop for Scope { fn drop(&mut self) { let ns = self.start.elapsed().as_nanos(); TIMES.with(|t| { let mut t = t.borrow_mut(); t[self.id].0 += ns; t[self.id].1 += 1; }); } }
pub(crate) struct Report(Instant);
impl Report { pub(crate) fn new() -> Self { TIMES.with(|t| *t.borrow_mut() = [(0, 0); 8]); Self(Instant::now()) } }
impl Drop for Report { fn drop(&mut self) { let total = self.0.elapsed().as_secs_f64()*1000.; TIMES.with(|t| { let t=t.borrow(); std::eprint!("RESEARCH_CODEC total_ms={total:.4}"); for (i,name) in ["prepare","rows","choose","transform","record","i16","i4","uv"].iter().enumerate() { std::eprint!(" {name}_ms={:.4} {name}_calls={}",t[i].0 as f64/1_000_000.,t[i].1); } std::eprintln!(); }); } }
