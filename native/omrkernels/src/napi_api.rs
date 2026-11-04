//! Node 侧外壳（`src/cli/omrkernels.node.ts` 加载）。就地写的缓冲区由 JS 传进来，这里按裸指针当可变切片写：
//! napi 的 TypedArray 只给只读借用，而调用期间 JS 侧不会碰这块内存（同步调用）。
use crate::core;
use napi::bindgen_prelude::*;
use napi_derive::napi;

fn as_mut<T>(p: *const T, n: usize) -> &'static mut [T] {
    unsafe { std::slice::from_raw_parts_mut(p as *mut T, n) }
}

#[napi]
pub fn connected_components(data: Uint8Array, w: u32, h: u32, min_area: f64, labels: Int32Array) -> Float64Array {
    let out = as_mut(labels.as_ptr(), labels.len());
    Float64Array::new(core::ccl::connected_components(&data, w as usize, h as usize, min_area, out))
}

#[napi]
pub fn ellipse_open(data: Uint8Array, w: u32, h: u32, rx: i32, ry: i32) -> Uint8Array {
    Uint8Array::new(core::morph::ellipse_open(&data, w as usize, h as usize, rx, ry))
}

#[napi]
pub fn box_morph(data: Uint8Array, w: u32, h: u32, r: u32, dilate: bool) {
    let d = as_mut(data.as_ptr(), data.len());
    core::morph::box_morph(d, w as usize, h as usize, r as usize, dilate);
}

#[napi]
pub fn run_lengths(data: Uint8Array, w: u32, h: u32, vertical: bool) -> Uint16Array {
    Uint16Array::new(core::runs::run_lengths(&data, w as usize, h as usize, vertical))
}

#[napi]
pub fn contour_features(labels: Int32Array, w: u32, h: u32, boxes: Int32Array) -> Int32Array {
    Int32Array::new(core::contour::contour_features(&labels, w as usize, h as usize, &boxes))
}

#[napi]
pub fn find_holes(data: Uint8Array, w: u32, h: u32, min_area: u32) -> Int32Array {
    Int32Array::new(core::contour::find_holes(&data, w as usize, h as usize, min_area))
}

#[napi]
pub fn hole_solidity(data: Uint8Array, w: u32, x: u32, y: u32, bw: u32, bh: u32) -> f64 {
    core::contour::hole_solidity(&data, w as usize, x as usize, y as usize, bw as usize, bh as usize)
}

#[napi]
pub fn to_gray(px: Uint8Array, w: u32, h: u32, step: u32) -> Uint8Array {
    Uint8Array::new(core::preprocess::to_gray(&px, w as usize, h as usize, step as usize))
}

#[napi]
pub fn sauvola_multi(gray: Uint8Array, w: u32, h: u32, r: u32, ks: Float64Array, out: Uint8Array) {
    let o = as_mut(out.as_ptr(), out.len());
    core::preprocess::sauvola_multi(&gray, w as usize, h as usize, r as usize, &ks, o);
}

#[napi]
pub fn upsample(gray: Uint8Array, w: u32, h: u32, up: u32) -> Uint8Array {
    Uint8Array::new(core::preprocess::upsample(&gray, w as usize, h as usize, up as usize))
}

#[napi]
pub fn score_at(data: Uint8Array, w: u32, h: u32, p: Float32Array, mw: u32, mh: u32, cx: f64, cy: f64) -> f64 {
    core::headmask::score_at(&data, w as usize, h as usize, &p, mw as usize, mh as usize, cx, cy)
}

/// `stem_x` 为 NaN 表示没给干。
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn score_at_masked(data: Uint8Array, w: u32, h: u32, p: Float32Array, mw: u32, mh: u32, cx: f64, cy: f64, stem_x: f64, stem_half: f64) -> f64 {
    core::headmask::score_at_masked(&data, w as usize, h as usize, &p, mw as usize, mh as usize, cx, cy, stem_x, stem_half)
}
