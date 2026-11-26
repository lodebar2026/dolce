//! 歌词音节的量宽（`engrave/syllable.ts::syllableRun`）：一个音节切成「前标点 / 主体 / 后标点」三段，
//! 宽度与逐字笔位一律取**标点挤压后**的那一串（量宽与绘制同一串坐标）。
//! 放在量字层而不是谱面元素层：场景树里歌词节点的 `update` 要用它（`dolce-engrave::scene` 在 `dolce-engrave` 之下）。

use crate::text::cjkpunct::{code_points, CompressMode, LYRIC_SPLIT_PUNCT, MIXED_PUNCT};
use crate::text::{Font, MeasureCtx};

/// 音节首尾当标点挂出去的字：两份表的并集（先旧简谱引擎那份，再补混排那份里没有的），同 TS `LYRIC_EDGE_PUNCT`。
pub fn lyric_edge_punct() -> &'static str {
    use std::sync::OnceLock;
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let mut out = String::new();
        for c in LYRIC_SPLIT_PUNCT.chars().chain(MIXED_PUNCT.chars()) {
            if !out.contains(c) {
                out.push(c);
            }
        }
        out
    })
}

/// 一个音节的量宽结果。
#[derive(Clone, Debug, PartialEq, Default)]
pub struct SyllableRun {
    /// 逐字（按码点）落笔点，相对音节起点；`none` 档或单字时为 None（连排）
    pub xs: Option<Vec<f64>>,
    pub width: f64,
    /// 前标点 / 主体 / 后标点三段宽
    pub lead: f64,
    pub body: f64,
    pub tail: f64,
}

/// 量一个音节（`syllableRun`）。`mode = None` 不挤压（逐字按 advance 连排）。
pub fn syllable_run(text: &str, font: &Font, mc: &MeasureCtx, mode: CompressMode) -> SyllableRun {
    let chars = code_points(text);
    let edge = lyric_edge_punct();
    let (mut nl, mut nc) = (0usize, chars.len());
    if chars.len() > 1 {
        let mut pos = 0;
        while pos < chars.len() && edge.contains(chars[pos]) {
            pos += 1;
        }
        nl = pos;
        while pos < chars.len() && !edge.contains(chars[pos]) {
            pos += 1;
        }
        nc = pos - nl;
    }
    let (xs, width) = if mode != CompressMode::None {
        let p = font.run(mc, text, mode);
        (p.xs, p.width)
    } else {
        let xs = (0..chars.len()).map(|i| font.measure_text(mc, &chars[..i].concat())).collect();
        (xs, font.measure_text(mc, text))
    };
    let at = |i: usize| -> f64 {
        if i == 0 {
            0.0
        } else if i >= xs.len() {
            width
        } else {
            xs[i]
        }
    };
    let (lead, end) = (at(nl), at(nl + nc));
    SyllableRun {
        xs: if mode != CompressMode::None && xs.len() > 1 { Some(xs.clone()) } else { None },
        width,
        lead,
        body: end - lead,
        tail: width - end,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edge_union() {
        let e = lyric_edge_punct();
        assert!(e.starts_with("1234567890.,;:'\"!?。："));
        // 混排那份补进来的
        assert!(e.contains('「') && e.contains('、') && e.contains('（'));
        assert_eq!(e.chars().filter(|c| *c == '“').count(), 1);
    }
}
