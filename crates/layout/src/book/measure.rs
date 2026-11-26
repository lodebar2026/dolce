//! 书级量字（TS `bookparts.ts::Measure` 与 dev `textmetrics.mjs` 那几个口子）：目录引导点要填多宽、注解正文折在哪、
//! 调号拍号避让——这些量的是**落进 PDF 的那份字体**（与写出端同一份字节、含标点挤压），不是排版引擎的量字。
//!
//! 迁移期由 TS 侧录下每次调用（`role` / `text` / `size` → 宽），这里回放（[`ReplayBookMeasure`]）；
//! 原生实现（读同一份字体文件、整形 + 挤压）到 L7 PDF 写出端时一并做。

use std::cell::RefCell;
use std::collections::HashMap;

pub trait BookMeasure {
    /// 一段字按 `role` 那一档字体、`size` 字号的宽（pt，含标点挤压；TS `metrics.advance(role, text, size)`）
    fn advance(&self, role: &str, text: &str, size: f64) -> f64;
    /// 角色样本字的「墨迹高 ÷ 字号」（TS `metrics.inkRatio(role, sample)`）；量不出为 NaN
    fn ink_ratio(&self, role: &str, sample: &str) -> f64;
}

/// 录下的一次调用（JSONL 一行）：`{"op":"advance","role","text","size","v"}` 或 `{"op":"inkRatio","role","sample","v"}`。
/// `v` 为 `null` 表示 NaN。
#[derive(serde::Deserialize)]
struct Rec {
    op: String,
    role: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    sample: Option<String>,
    #[serde(default)]
    size: Option<f64>,
    v: Option<f64>,
}

fn adv_key(role: &str, text: &str, size: f64) -> String {
    format!("a\u{1}{role}\u{1}{text}\u{1}{}", dolce_model::base::js::num_to_string(size))
}
fn ink_key(role: &str, sample: &str) -> String {
    format!("i\u{1}{role}\u{1}{sample}")
}

/// 回放 TS 录下的书级量字；没录到的记进 `misses`、按 0（宽）/ NaN（比例）给
pub struct ReplayBookMeasure {
    table: HashMap<String, f64>,
    pub misses: RefCell<Vec<String>>,
}

impl ReplayBookMeasure {
    pub fn from_jsonl(text: &str) -> Result<Self, serde_json::Error> {
        let mut table = HashMap::new();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let r: Rec = serde_json::from_str(line)?;
            let v = r.v.unwrap_or(f64::NAN);
            let k = match r.op.as_str() {
                "inkRatio" => ink_key(&r.role, r.sample.as_deref().unwrap_or("")),
                _ => adv_key(&r.role, r.text.as_deref().unwrap_or(""), r.size.unwrap_or(0.0)),
            };
            table.insert(k, v);
        }
        Ok(ReplayBookMeasure { table, misses: RefCell::new(Vec::new()) })
    }
    pub fn miss_count(&self) -> usize {
        self.misses.borrow().len()
    }
}

impl BookMeasure for ReplayBookMeasure {
    fn advance(&self, role: &str, text: &str, size: f64) -> f64 {
        let k = adv_key(role, text, size);
        match self.table.get(&k) {
            Some(v) => *v,
            None => {
                self.misses.borrow_mut().push(format!("advance {role} {text:?} {size}"));
                0.0
            }
        }
    }
    fn ink_ratio(&self, role: &str, sample: &str) -> f64 {
        match self.table.get(&ink_key(role, sample)) {
            Some(v) => *v,
            None => {
                self.misses.borrow_mut().push(format!("inkRatio {role} {sample:?}"));
                f64::NAN
            }
        }
    }
}
