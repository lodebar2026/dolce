//! 位图识别的像素内核：`core` 是纯函数（与 `src/omrkit`、`src/rasteromr` 里的 TS 实现逐项相同，
//! 改一边必须改另一边，`dev/tests/omrkit/kernels.test.ts` 逐项比对），`napi` 是 Node 侧外壳。

pub mod core;

#[cfg(feature = "napi")]
mod napi_api;
