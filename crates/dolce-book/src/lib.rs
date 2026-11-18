//! 成书排版（照 `src/pdflayout/` 与 dev `rebuild.mjs` 的整本那一层）。只供对拍（L6），TS 那份照旧在用；判据与阈值照搬，原文注释里的曲目病例留在 TS 那份。
//!
//! - [`draw`]：DrawList（`drawlist.ts`）——两条重排路与 PDF 输出之间的唯一契约，外加对开镜像平移、逐角色计数
//! - [`spec`]：原书一页的版面规格 `PageSpec`（`spec.ts` 的类型；由原书 PDF 抽出，Rust 这边只读 JSON）
//! - [`measure`]：书级量字（目录引导点、注解折行、调号拍号避让）的注入接口与录放后端
//! - [`scenedraw`]：成书这一路排一首（`browser.ts`）：读谱、简谱引擎 `book` 档、页面树 → DrawList、数谱行
//! - [`relayout`]：A 路 `specToDrawPage`
//! - [`parts`]：书级内容 → DrawList（`bookparts.ts`：调号拍号、花边框、注解块、目录、索引、扉页）
//! - [`template`]：模板件（`booktemplate.ts`：模板排版结果 → 图元、`key-meter()` 组件）
//! - [`manifest`]：书清单 `book.json`（`manifest.ts`）
//! - [`align`]：GT 字符序列 ↔ 页面字形序列的对齐（`align.ts`）
//! - [`meta`]：书级元数据（`bookmeta.ts`）；[`stats`]：从原书版面统计 BookStyle（`stats.ts`）
//! - [`songbook`]：混排歌本（`songbook.ts`）
//! - [`rebuild`]：B 路整本（dev `rebuild.mjs`：逐首断句与排版迭代、装箱、注解落位、装订、装饰层）

pub mod align;
pub mod draw;
pub mod manifest;
pub mod measure;
pub mod meta;
pub mod parts;
pub mod rebuild;
pub mod relayout;
pub mod scenedraw;
pub mod songbook;
pub mod spec;
pub mod stats;
pub mod template;
