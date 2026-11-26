//! 简谱引擎（照 `src/layout/jianpu/`）：排版行视图（[`view`]）→ 定位结构（`place`，[`model`]）→ 场景节点（`compose`）。
//! 对外经 `dolce-layout`（`layout::layout_jianpu_doc`）调；判据与阈值照 TS 原版搬来，曲目病例见仓库文档。
//! 身份不靠对象引用：元素 id、歌词归属、遍号在 [`view::LRow`] 里按下标平行存，定位结构里另存（见 [`model`]）。

pub mod barspec;
pub mod compose;
pub mod grid;
pub mod ink;
pub mod model;
pub mod paginate;
pub mod place;
pub mod placedjson;
pub mod util;
pub mod view;
