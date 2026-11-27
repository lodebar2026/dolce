//! 悦谱 Dolce **排版的对外入口**：把 [`dolce_model::doc::ScoreDoc`] 排成简谱、五线谱或混排的页面场景，排歌本成书，导出矢量 PDF / PPTX。
//! 网页版（wasm）、桌面版（Tauri）、命令行 `dolce` 都经这里排版。
//!
//! ## 模块
//!
//! - **[`layout`]**：单曲排版入口——[`layout::layout_jianpu_doc`]（简谱 / 投影档）、[`layout::layout_staff_doc`]（五线谱 / 混排）、
//!   [`layout::engraved_music_xml`]（带五线谱版面坐标的 MusicXML）；量字与 SMuFL 元数据由宿主经 [`dolce_engrave::Env`] 给。
//! - **[`book`]**：成书排版——`DrawList`、书级部件（目录、索引、扉页、注解块、花边框）、成书重排与混排歌本。
//! - **`export`**（`export` 特性）：场景 / 成书 → 矢量 PDF（`krilla`，嵌字或转曲）、场景 → 矢量 PPTX。
//! - **[`sing`]**：按参照歌词生成段落标记与逐遍演唱顺序 `%%sing`，给投影档用。
//! - **[`Session`]**：文档会话，一个会话对应一份打开的文档。[`Session::update`] 交原文、回修订号；其余调用都带修订号，
//!   会话手里已是更新的修订时以 [`EngineError::Stale`] 拒绝（调用方丢掉结果即可，不是错误）。排队由宿主做
//!   （wasm 单线程天然串行；Tauri 命令按会话加锁）。**还只是骨架**：取页、写出仍回 `engine.unimplemented`，排版走 [`layout`]。
//!
//! ## 示例
//!
//! 排一份 123 的简谱、取第一页 SVG。量字器由宿主给：开 `dolce-engrave/native` 时用系统量字，或自己实现 [`dolce_engrave::text::TextMeasurer`]。
//!
//! ```no_run
//! use dolce_engrave::scene::svg::page_svg;
//! use dolce_engrave::text::{MeasureCtx, TextMeasurer};
//! use dolce_engrave::Env;
//! use dolce_layout::layout::{layout_jianpu_doc, JianpuRequest};
//! use dolce_model::formats::abc::parse::parse_123;
//!
//! fn render_first_page(measurer: &dyn TextMeasurer) -> Result<String, String> {
//!     let doc = parse_123("T:小星星\nK:C\nM:4/4\n1 1 5 5 | 6 6 5 - |\n");
//!     let mc = MeasureCtx::new(measurer);
//!     let env = Env { mc: &mc, meta: None };
//!     let req = JianpuRequest { view: "original".into(), ..Default::default() };
//!     let laid = layout_jianpu_doc(&doc, &req, &env)?;
//!     Ok(page_svg(&laid.pages[0]))
//! }
//! ```
//!
//! ## 特性
//!
//! - `export`：`export` 模块（PDF / PPTX，字体字节由宿主给；网页 wasm 只开这个）。
//! - `export-system`（默认）：再加系统字体与成书 PDF（桌面与命令行开）。

#![cfg_attr(docsrs, feature(doc_cfg))]

// 并入的成书与导出（原各自一个 crate）
pub mod book;
#[cfg(feature = "export")]
pub mod export;
pub mod layout;
pub mod sing;

use dolce_model::base::Msg;
use serde::{Deserialize, Serialize};

/// 按键路径的一次往返（同 `UpdateRequest`；排版设置随 L 期加）。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateRequest {
    pub text: String,
    /// `DocFormatId`：`123` / `abc` / `musicxml` / `jpwabc` / `fanqie` / `jly` / `jcx`
    pub format: String,
    /// `EngineView`：`expanded` / `original` / `staff` / `mixed`
    pub view: String,
}

/// 页尺寸（排版单位，同 `ScorePainter.pageSize`）。
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct PageInfo {
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateReply {
    pub rev: u32,
    /// 解析告警（不拦排版）——诊断类型随 M2 的模型一起来，现在恒空
    pub diagnostics: Vec<Msg>,
    pub pages: Vec<PageInfo>,
}

/// 会话调用的失败（同 TS 的 `StaleRevision` / `EngineFailure`）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EngineError {
    /// 调用带的修订号已被新的 `update` 取代
    Stale { rev: u32, current: u32 },
    /// 读不出、排不了、还没实现：`msg` 给状态栏（文字由 TS `t()` 出）
    Failure { rev: u32, msg: Msg },
}

pub type Reply<T> = Result<T, EngineError>;

/// 一份修订的文档状态（M2 起挂模型、表层、投影；L 期挂场景树）。
#[derive(Debug)]
struct DocState {
    text: String,
    format: String,
    view: String,
}

#[derive(Debug, Default)]
pub struct Session {
    rev: u32,
    doc: Option<DocState>,
}

impl Session {
    pub fn new() -> Session {
        Session::default()
    }

    /// 当前修订号（还没 `update` 过为 0）。
    pub fn rev(&self) -> u32 {
        self.rev
    }

    /// 交原文、按请求排好。修订号先前进（旧修订的在途调用随之作废），读不出、排不了也照样前进。
    pub fn update(&mut self, req: UpdateRequest) -> Reply<UpdateReply> {
        self.rev += 1;
        self.doc = Some(DocState { text: req.text, format: req.format, view: req.view });
        Ok(UpdateReply { rev: self.rev, diagnostics: Vec::new(), pages: Vec::new() })
    }

    /// 修订号还是当前的（且 `update` 过）。
    fn fresh(&self, rev: u32) -> Reply<&DocState> {
        if rev != self.rev {
            return Err(EngineError::Stale { rev, current: self.rev });
        }
        self.doc.as_ref().ok_or_else(|| EngineError::Failure { rev, msg: Msg::new("engine.noDocument") })
    }

    fn unimplemented<T>(&self, rev: u32, op: &str) -> Reply<T> {
        let d = self.fresh(rev)?;
        Err(EngineError::Failure { rev, msg: Msg::new("engine.unimplemented").arg("op", op).arg("format", d.format.as_str()).arg("view", d.view.as_str()) })
    }

    /// 第 `index` 页的 SVG。
    pub fn page(&self, rev: u32, _index: u32) -> Reply<String> {
        self.unimplemented(rev, "page")
    }

    /// 整份写成某种格式。
    pub fn emit(&self, rev: u32, _target: &str) -> Reply<String> {
        self.unimplemented(rev, "emit")
    }

    /// 这份修订的原文（宿主核对用）。
    pub fn text(&self, rev: u32) -> Reply<&str> {
        self.fresh(rev).map(|d| d.text.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(t: &str) -> UpdateRequest {
        UpdateRequest { text: t.into(), format: "123".into(), view: "original".into() }
    }

    #[test]
    fn revisions_and_staleness() {
        let mut s = Session::new();
        assert!(matches!(s.page(0, 0), Err(EngineError::Failure { .. })));
        let r1 = s.update(req("a")).unwrap().rev;
        assert_eq!(s.text(r1), Ok("a"));
        let r2 = s.update(req("b")).unwrap().rev;
        assert_eq!(s.text(r1), Err(EngineError::Stale { rev: r1, current: r2 }));
        assert_eq!(s.text(r2), Ok("b"));
        match s.emit(r2, "abc") {
            Err(EngineError::Failure { msg, .. }) => assert_eq!(msg.key, "engine.unimplemented"),
            other => panic!("{other:?}"),
        }
    }
}
