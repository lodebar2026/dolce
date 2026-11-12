//! 进度与取消：识别各阶段之间报一步、查一次取消（桌面版、网页版的识别跑在后台，界面要显示进度、按 Esc 能停）。
//! 粒度是阶段与页，不深入判据循环；取消后上层回 [`CANCELLED`]。
use std::sync::atomic::{AtomicBool, Ordering};

/// 取消时识别回的错误文字（上层按它认出「是取消，不是失败」）。
pub const CANCELLED: &str = "已取消";

/// 一步进度：第几步 / 共几步，阶段名（`page` / `rows` / `notes` / `lyrics` / `header` / `spans` / `beats` / `assemble`）。
#[derive(Clone, Copy, Debug)]
pub struct Step<'s> {
    pub done: usize,
    pub total: usize,
    pub stage: &'s str,
}

/// 进度回调与取消标志，都可以没有。
#[derive(Clone, Copy, Default)]
pub struct Hook<'a> {
    pub on: Option<&'a (dyn Fn(Step) + Sync)>,
    pub cancel: Option<&'a AtomicBool>,
}

impl<'a> Hook<'a> {
    pub const NONE: Hook<'static> = Hook { on: None, cancel: None };

    pub fn cancelled(&self) -> bool {
        self.cancel.is_some_and(|c| c.load(Ordering::Relaxed))
    }

    /// 报一步；已取消回 `Err(CANCELLED)`。
    pub fn step(&self, done: usize, total: usize, stage: &str) -> Result<(), String> {
        if self.cancelled() {
            return Err(CANCELLED.into());
        }
        if let Some(f) = self.on {
            f(Step { done, total, stage });
        }
        Ok(())
    }
}
