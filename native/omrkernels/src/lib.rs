//! 位图识别像素内核的 Node 侧外壳（napi）。内核本体在 `crates/omr-core` 的 `pixel` 模块
//! （与 `src/omrkit`、`src/rasteromr` 里的 TS 实现逐项相同，改一边必须改另一边，`dev/tests/omrkit/kernels.test.ts` 逐项比对）。

pub use dolce_omr_core::pixel as core;

#[cfg(feature = "napi")]
mod napi_api;
