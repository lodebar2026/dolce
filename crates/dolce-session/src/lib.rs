//! 文档会话（`src/engine/api.ts::EngineSession` 的 Rust 侧，照 `omr-engine/src/handle.rs` 的范式）。
//!
//! 一个会话对应一份打开的文档。[`Session::update`] 交原文与排版请求、回修订号；其余调用都带修订号，
//! 会话手里已经是更新的修订时以 [`EngineError::Stale`] 拒绝（调用方丢掉结果即可，不是错误）。
//! 排队由宿主做（wasm 单线程天然串行；Tauri 命令按会话加锁）。
//!
//! **M0 只是骨架**：`update` 记下原文、推进修订号；模型（M2）、排版（L 期）接上之前，取页、编辑、写出、试听一律回
//! `engine.unimplemented`。

pub mod layout;
pub mod sing;

use dolce_base::Msg;
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
