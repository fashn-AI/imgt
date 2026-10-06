use std::{
    ffi::{c_char, c_int, c_void, CStr},
    ptr,
    sync::Mutex,
};
unsafe extern "C" {
    fn vips_init(name: *const c_char) -> c_int;
    fn vips_shutdown();
    fn vips_thread_shutdown();
    fn vips_concurrency_set(n: c_int);
    fn vips_cache_set_max(n: c_int);
    fn vips_version_string() -> *const c_char;
    fn vips_image_new_from_buffer(
        data: *const c_void,
        len: usize,
        options: *const c_char,
        ...
    ) -> *mut c_void;
    fn vips_image_get_width(image: *mut c_void) -> c_int;
    fn vips_image_get_height(image: *mut c_void) -> c_int;
    fn vips_image_get_typeof(image: *mut c_void, name: *const c_char) -> usize;
    fn vips_image_get_interpretation(image: *mut c_void) -> c_int;
    fn vips_image_get_format(image: *mut c_void) -> c_int;
    fn vips_image_get_orientation(image: *mut c_void) -> c_int;
    fn vips_image_hasalpha(image: *mut c_void) -> c_int;
    fn vips_image_set_kill(image: *mut c_void, kill: c_int);
    fn vips_image_set_progress(image: *mut c_void, progress: c_int);
    fn vips_icc_transform(
        image: *mut c_void,
        out: *mut *mut c_void,
        profile: *const c_char,
        ...
    ) -> c_int;
    fn vips_colourspace(image: *mut c_void, out: *mut *mut c_void, space: c_int, ...) -> c_int;
    fn vips_cast(image: *mut c_void, out: *mut *mut c_void, format: c_int, ...) -> c_int;
    fn vips_premultiply(image: *mut c_void, out: *mut *mut c_void, ...) -> c_int;
    fn vips_unpremultiply(image: *mut c_void, out: *mut *mut c_void, ...) -> c_int;
    fn vips_resize(image: *mut c_void, out: *mut *mut c_void, scale: f64, ...) -> c_int;
    fn vips_autorot(image: *mut c_void, out: *mut *mut c_void, ...) -> c_int;
    fn vips_webpsave_buffer(
        image: *mut c_void,
        out: *mut *mut c_void,
        len: *mut usize,
        ...
    ) -> c_int;
    fn vips_error_buffer() -> *const c_char;
    fn vips_error_clear();
    fn g_free(data: *mut c_void);
    fn g_object_ref(data: *mut c_void) -> *mut c_void;
    fn g_object_unref(data: *mut c_void);
}
pub fn initialize() -> Result<String, String> {
    unsafe {
        if vips_init(c"imgt".as_ptr()) != 0 {
            return Err(error());
        }
        vips_concurrency_set(1);
        vips_cache_set_max(0);
        Ok(CStr::from_ptr(vips_version_string())
            .to_string_lossy()
            .into_owned())
    }
}
pub fn shutdown() {
    unsafe {
        vips_shutdown();
    }
}
fn error() -> String {
    unsafe {
        let result = CStr::from_ptr(vips_error_buffer())
            .to_string_lossy()
            .into_owned();
        vips_error_clear();
        result
    }
}
struct Image(*mut c_void);
impl Image {
    fn new(raw: *mut c_void) -> Result<Self, String> {
        if raw.is_null() {
            Err(error())
        } else {
            Ok(Self(raw))
        }
    }
    fn checked(status: c_int, raw: *mut c_void) -> Result<Self, String> {
        if status != 0 {
            if !raw.is_null() {
                unsafe { g_object_unref(raw) }
            };
            Err(error())
        } else {
            Self::new(raw)
        }
    }
}
impl Drop for Image {
    fn drop(&mut self) {
        unsafe { g_object_unref(self.0) }
    }
}
// The mutex owns an additional native reference. A cancellation never accesses
// an image after its native evaluation or reference release has completed.
#[derive(Default)]
pub struct Control {
    inner: Mutex<(bool, usize)>,
}
impl Control {
    pub fn cancel(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.0 = true;
        if inner.1 != 0 {
            unsafe { vips_image_set_kill(inner.1 as *mut c_void, 1) }
        }
    }
    pub fn canceled(&self) -> bool {
        self.inner.lock().unwrap().0
    }
    fn register(&self, image: &Image) {
        let mut inner = self.inner.lock().unwrap();
        unsafe {
            g_object_ref(image.0);
            inner.1 = image.0 as usize;
            vips_image_set_progress(image.0, 1);
            if inner.0 {
                vips_image_set_kill(image.0, 1);
            }
        }
    }
    fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.1 != 0 {
            unsafe { g_object_unref(inner.1 as *mut c_void) };
            inner.1 = 0;
        }
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        self.clear();
    }
}
struct Registration<'a>(&'a Control);
impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.0.clear();
    }
}
macro_rules! image_op {($call:ident,$image:expr $(,$arg:expr)*)=>{{let mut out=ptr::null_mut();Image::checked($call($image.0,&mut out,$($arg,)*ptr::null::<c_char>()),out)?}};}
// Each output buffer is owned exclusively, immutable after encoding, and
// freed by g_free when the last HTTP Bytes reference is released.
struct NativeBuffer {
    data: std::ptr::NonNull<u8>,
    len: usize,
}
unsafe impl Send for NativeBuffer {}
impl AsRef<[u8]> for NativeBuffer {
    fn as_ref(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.data.as_ptr(), self.len) }
    }
}
impl Drop for NativeBuffer {
    fn drop(&mut self) {
        unsafe { g_free(self.data.as_ptr().cast()) }
    }
}
struct ThreadCleanup;
impl Drop for ThreadCleanup {
    fn drop(&mut self) {
        unsafe {
            vips_error_clear();
            vips_thread_shutdown();
        }
    }
}
pub struct Encoded {
    pub data: axum::body::Bytes,
    pub prepare_ms: f64,
    pub encode_ms: f64,
    pub output_ms: f64,
}
// Limited to imgt's public transform options. The input Bytes remains alive until
// every lazy native image depending on its borrowed bytes has been released.
pub fn encode(
    input: axum::body::Bytes,
    width: i32,
    quality: i32,
    effort: i32,
    control: &Control,
) -> Result<Encoded, String> {
    let _cleanup = ThreadCleanup;
    let begun = std::time::Instant::now();
    unsafe {
        if control.canceled() {
            return Err("canceled".into());
        }
        let mut image = Image::new(vips_image_new_from_buffer(
            input.as_ptr().cast(),
            input.len(),
            c"".as_ptr(),
            c"access".as_ptr(),
            1i32,
            c"fail_on".as_ptr(),
            2i32,
            ptr::null::<c_char>(),
        ))?;
        let initial_width = vips_image_get_width(image.0);
        let initial_height = vips_image_get_height(image.0);
        if initial_width as i64 * initial_height as i64 > 50_000_000 {
            return Err("input pixel limit exceeded".into());
        }
        let orient = vips_image_get_orientation(image.0);
        let swap = orient >= 5;
        let initial_axis = if swap { initial_height } else { initial_width };
        let shrink = (initial_axis as f64 / width as f64)
            .max(1.0)
            .min(initial_width as f64)
            .min(initial_height as f64);
        if input.starts_with(&[255, 216]) {
            let mut load_shrink = if shrink >= 8.0 {
                8
            } else if shrink >= 4.0 {
                4
            } else if shrink >= 2.0 {
                2
            } else {
                1
            };
            if load_shrink > 1 && shrink as i32 == load_shrink {
                load_shrink /= 2;
            }
            if load_shrink > 1 {
                image = Image::new(vips_image_new_from_buffer(
                    input.as_ptr().cast(),
                    input.len(),
                    c"".as_ptr(),
                    c"shrink".as_ptr(),
                    load_shrink,
                    c"access".as_ptr(),
                    1i32,
                    c"fail_on".as_ptr(),
                    2i32,
                    ptr::null::<c_char>(),
                ))?;
            }
        } else if input.starts_with(b"RIFF") && input.get(8..12) == Some(b"WEBP") && shrink > 1.0 {
            image = Image::new(vips_image_new_from_buffer(
                input.as_ptr().cast(),
                input.len(),
                c"".as_ptr(),
                c"scale".as_ptr(),
                1.0 / shrink,
                c"access".as_ptr(),
                1i32,
                c"fail_on".as_ptr(),
                2i32,
                ptr::null::<c_char>(),
            ))?;
        }
        let space = vips_image_get_interpretation(image.0);
        let has_profile = vips_image_get_typeof(image.0, c"icc-profile-data".as_ptr()) != 0;
        let deferred = has_profile && space == 22 && vips_image_get_format(image.0) == 0;
        let sixteen = space == 25 || space == 26;
        let processing = if space == 25 { c"p3" } else { c"srgb" };
        if has_profile && space != 21 && space != 26 && !deferred {
            let converted = (|| -> Result<Image, String> {
                Ok(image_op!(
                    vips_icc_transform,
                    image,
                    processing.as_ptr(),
                    c"embedded".as_ptr(),
                    1i32,
                    c"depth".as_ptr(),
                    if sixteen { 16i32 } else { 8i32 },
                    c"intent".as_ptr(),
                    0i32
                ))
            })();
            if let Ok(converted) = converted {
                image = converted;
            }
        } else if space == 15 {
            image = image_op!(
                vips_icc_transform,
                image,
                processing.as_ptr(),
                c"input_profile".as_ptr(),
                c"cmyk".as_ptr(),
                c"intent".as_ptr(),
                0i32
            );
        }
        let iw = vips_image_get_width(image.0);
        let ih = vips_image_get_height(image.0);
        let axis = if swap { ih } else { iw };
        let factor = (axis as f64 / width as f64).max(1.0);
        let hs = factor.min(iw as f64);
        let vs = factor.min(ih as f64);
        let resized = hs != 1.0 || vs != 1.0;
        let format = vips_image_get_format(image.0);
        let premultiply = resized && vips_image_hasalpha(image.0) != 0;
        if premultiply {
            image = image_op!(vips_premultiply, image);
            image = image_op!(vips_cast, image, format);
        }
        if resized {
            image = image_op!(
                vips_resize,
                image,
                1.0 / hs,
                c"vscale".as_ptr(),
                1.0 / vs,
                c"kernel".as_ptr(),
                5i32
            );
        }
        image = image_op!(vips_autorot, image);
        if premultiply {
            image = image_op!(vips_unpremultiply, image);
            image = image_op!(vips_cast, image, format);
        }
        let space = vips_image_get_interpretation(image.0);
        if space == 25 || space == 26 {
            image = image_op!(vips_cast, image, 2i32);
        }
        if space != 22 {
            image = image_op!(
                vips_colourspace,
                image,
                22i32,
                c"source_space".as_ptr(),
                space
            );
        }
        if deferred {
            let converted = (|| -> Result<Image, String> {
                Ok(image_op!(
                    vips_icc_transform,
                    image,
                    c"srgb".as_ptr(),
                    c"embedded".as_ptr(),
                    1i32,
                    c"input_profile".as_ptr(),
                    c"srgb".as_ptr(),
                    c"depth".as_ptr(),
                    8i32,
                    c"intent".as_ptr(),
                    0i32
                ))
            })();
            if let Ok(converted) = converted {
                image = converted;
            }
        }
        control.register(&image);
        let _registration = Registration(control);
        if control.canceled() {
            return Err("canceled".into());
        }
        let mut encoded = ptr::null_mut();
        let mut len = 0usize;
        let prepare_ms = begun.elapsed().as_secs_f64() * 1000.;
        let encode_start = std::time::Instant::now();
        let status = vips_webpsave_buffer(
            image.0,
            &mut encoded,
            &mut len,
            c"Q".as_ptr(),
            quality,
            c"effort".as_ptr(),
            effort,
            c"strip".as_ptr(),
            1i32,
            ptr::null::<c_char>(),
        );
        if status != 0 {
            if !encoded.is_null() {
                g_free(encoded)
            };
            return Err(error());
        }
        let encode_ms = encode_start.elapsed().as_secs_f64() * 1000.;
        let output_start = std::time::Instant::now();
        let buffer = NativeBuffer {
            data: std::ptr::NonNull::new(encoded.cast::<u8>()).ok_or("empty encoder output")?,
            len,
        };
        let data = axum::body::Bytes::from_owner(buffer);
        let output_ms = output_start.elapsed().as_secs_f64() * 1000.;
        if control.canceled() {
            return Err("canceled".into());
        }
        Ok(Encoded {
            data,
            prepare_ms,
            encode_ms,
            output_ms,
        })
    }
}
