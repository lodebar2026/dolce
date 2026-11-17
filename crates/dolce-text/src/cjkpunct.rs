//! CJK 标点分类与「标点挤压」（CLREQ 3.1.6），照 `src/common/cjkpunct.ts` 的度量那一半。
//! 道理、各档口径与踩过的坑见 TS 原文注释；这里只搬规则，度量由调用方给（`advance` / `slack`）。
//! 歌词切分那几张具名字符表（`LYRIC_SPLIT_PUNCT` 等）跟着用到它们的排版期迁过来。

/// 标点的挤压类别。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PunctClass {
    /// 起始类：左半空（`“（「`）
    Open,
    /// 收尾类：右半空（`”）」`）
    Close,
    /// 句读点号：右半空（`。，、；：！？`）
    Stop,
    /// 占满一格、两侧都不空（`…—·`）
    Middle,
    None,
}

// 只收全角形（ASCII 括号与半角形没有那半格，压了就压到墨上）
const OPEN: &str = "“‘（「『《〈【〔［｛";
const CLOSE: &str = "”’）」』》〉】〕］｝";
const STOP: &str = "。，、；：！？";
const MIDDLE: &str = "…—‥·・";

/// `punctClass(ch)`。TS 用 `includes`：`ch` 是多字串时按子串找（调用方都只给单字）。
pub fn punct_class(ch: &str) -> PunctClass {
    if ch.is_empty() {
        return PunctClass::None;
    }
    if OPEN.contains(ch) {
        PunctClass::Open
    } else if CLOSE.contains(ch) {
        PunctClass::Close
    } else if STOP.contains(ch) {
        PunctClass::Stop
    } else if MIDDLE.contains(ch) {
        PunctClass::Middle
    } else {
        PunctClass::None
    }
}

/// 左侧能压掉的 em。
pub fn trim_left(ch: &str) -> f64 {
    if punct_class(ch) == PunctClass::Open {
        0.5
    } else {
        0.0
    }
}

/// 右侧能压掉的 em。
pub fn trim_right(ch: &str) -> f64 {
    match punct_class(ch) {
        PunctClass::Close | PunctClass::Stop => 0.5,
        _ => 0.0,
    }
}

/// 相邻两字之间压掉几个 em（全身式：两截空白超过半格才压到只剩半格）。
pub fn pair_trim(prev: &str, next: &str) -> f64 {
    if prev.is_empty() || next.is_empty() {
        return 0.0;
    }
    dolce_base::js::max(0.0, trim_right(prev) + trim_left(next) - 0.5)
}

/// 行末那个字能悬挂 / 压缩出去的量（em）。
pub fn hang_trim(ch: &str) -> f64 {
    trim_right(ch)
}

/// 行首那个字能压掉的量（em）。
pub fn head_trim(ch: &str) -> f64 {
    trim_left(ch)
}

/// 挤压档：`clreq` 全身式 + 上下文挤压（书级正文）、`halfwidth` 半身式（简谱歌词）、`none` 不压。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CompressMode {
    #[default]
    Clreq,
    Halfwidth,
    None,
}

/// 一个字两侧的实际留白（px，advance 减墨迹）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SlackLR {
    pub left: f64,
    pub right: f64,
}

/// 相邻两个标点收拢后留多少（em）。
pub const PUNCT_PAIR_GAP: f64 = 0.1;

fn trim_left_px(ch: &str, em: f64, slack: Option<&dyn Fn(&str) -> SlackLR>) -> f64 {
    let want = trim_left(ch) * em;
    match slack {
        Some(s) => dolce_base::js::min(want, dolce_base::js::max(0.0, s(ch).left)),
        None => want,
    }
}

fn trim_right_px(ch: &str, em: f64, slack: Option<&dyn Fn(&str) -> SlackLR>) -> f64 {
    let want = trim_right(ch) * em;
    match slack {
        Some(s) => dolce_base::js::min(want, dolce_base::js::max(0.0, s(ch).right)),
        None => want,
    }
}

/// 相邻两字之间压掉几个 em——按档。
pub fn pair_trim_in(mode: CompressMode, prev: &str, next: &str) -> f64 {
    match mode {
        CompressMode::None => 0.0,
        CompressMode::Halfwidth => trim_right(prev) + trim_left(next),
        CompressMode::Clreq => pair_trim(prev, next),
    }
}

/// 同上，出像素且受墨迹封顶。挤压量的规则出口。
pub fn pair_trim_px(mode: CompressMode, prev: &str, next: &str, em: f64, slack: Option<&dyn Fn(&str) -> SlackLR>) -> f64 {
    use dolce_base::js::{max, min};
    if mode == CompressMode::None || prev.is_empty() || next.is_empty() {
        return 0.0;
    }
    let r = trim_right_px(prev, em, slack);
    let l = trim_left_px(next, em, slack);
    if mode == CompressMode::Halfwidth {
        return r + l;
    }
    max(0.0, min(r + l, trim_right(prev) * em + trim_left(next) * em - 0.5 * em))
}

/// 一串字挤压后的逐字笔位与总宽（`compressRun`）。`chars` 按码点。
pub fn compress_run(
    chars: &[&str],
    advance_of: &dyn Fn(&str) -> f64,
    em: f64,
    mode: CompressMode,
    slack: Option<&dyn Fn(&str) -> SlackLR>,
) -> (Vec<f64>, f64) {
    use dolce_base::js::max;
    let mut xs = Vec::with_capacity(chars.len());
    let mut x = 0.0f64;
    let mut prev_pad = -1.0f64;
    for (i, &ch) in chars.iter().enumerate() {
        if mode == CompressMode::Halfwidth {
            let adv = advance_of(ch);
            let can_trim = trim_left(ch) > 0.0 || trim_right(ch) > 0.0;
            if !can_trim {
                xs.push(x);
                x += adv;
                prev_pad = -1.0;
                continue;
            }
            if let Some(s) = slack {
                let sk = s(ch);
                let ink_w = max(0.0, adv - max(0.0, sk.left) - max(0.0, sk.right));
                let w = max(0.5 * em, ink_w);
                let pad = (w - ink_w) / 2.0;
                if prev_pad >= 0.0 {
                    x -= max(0.0, prev_pad + pad - PUNCT_PAIR_GAP * em);
                }
                xs.push(x - max(0.0, sk.left) + pad);
                x += w;
                prev_pad = pad;
                continue;
            }
            prev_pad = -1.0;
            let l = trim_left_px(ch, em, None);
            xs.push(x - l);
            x += adv - l - trim_right_px(ch, em, None);
            continue;
        }
        prev_pad = -1.0;
        if i > 0 && mode != CompressMode::None {
            x -= pair_trim_px(mode, chars[i - 1], ch, em, slack);
        }
        xs.push(x);
        x += advance_of(ch);
    }
    let _ = prev_pad;
    (xs, x)
}

/// 按码点切（同 TS `[...text]`）。
pub fn code_points(text: &str) -> Vec<&str> {
    text.char_indices().map(|(i, c)| &text[i..i + c.len_utf8()]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_and_trims() {
        assert_eq!(punct_class("“"), PunctClass::Open);
        assert_eq!(punct_class("。"), PunctClass::Stop);
        assert_eq!(punct_class("("), PunctClass::None);
        assert_eq!(pair_trim("：", "“"), 0.5);
        assert_eq!(pair_trim("。", "人"), 0.0);
        assert_eq!(pair_trim_in(CompressMode::Halfwidth, "。", "人"), 0.5);
    }

    #[test]
    fn run_clreq_and_halfwidth() {
        let adv = |_: &str| 10.0;
        let cs = code_points("说：“好");
        let (xs, w) = compress_run(&cs, &adv, 10.0, CompressMode::Clreq, None);
        assert_eq!(xs, vec![0.0, 10.0, 15.0, 25.0]);
        assert_eq!(w, 35.0);
        let (xs, w) = compress_run(&cs, &adv, 10.0, CompressMode::Halfwidth, None);
        assert_eq!(xs, vec![0.0, 10.0, 10.0, 20.0]);
        assert_eq!(w, 30.0);
    }
}
