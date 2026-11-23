//! 模型、格式、排版各层共用的最底层（只依赖 serde，能编到 wasm）。
//!
//! - [`js`]：与 TS 逐字相同要守的数值口径（取整、截断、排序、数与字符串互转）
//! - [`fraction`]：`common/fraction.ts` 的分数（分子分母照 TS 用 f64）
//! - [`text`]：UTF-16 位置表与源码区间（`SourceSpan` 的偏移是 UTF-16 码元，喂 CodeMirror）
//! - [`geom`]：排版几何（照 `src/common/geom.ts`、`pathbounds.ts`）：点、矩形、3×3 矩阵、颜色、SVG 路径紧包围盒
//! - [`msg`]：交给界面的提示——只给键与参数，文字由 TS 的 `t()` 出

pub mod fraction;
pub mod geom;
pub mod js;
pub mod msg;
pub mod tagged;
pub mod text;

pub use fraction::Fraction;
pub use msg::{Msg, MsgArg};
pub use text::{SourceSpan, Utf16Index};
