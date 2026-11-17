//! 反复展开的公共那一半：按演唱顺序（[`PlayItem`] 序列）逐遍走小节（TS `jianpu/expand.ts::walkPlay` 照搬）。
//!
//! 「这首歌该唱成什么样」由 [`crate::playorder`] 推；这里只管**怎么走**——逐遍、逐小节、首尾小节的裁切、遍末与往回跳换页。
//! 「怎么放一个小节」由消费者决定（投影档往行里装小节、识别歌词对照按遍串词），所以产出是一串步骤（[`Step`]），由消费者回放。

use crate::playorder::PlayItem;

/// 走一遍要用的那几项（`PlayItem` 的子集；门面按扁平数组传进来时直接拼这个）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WalkItem {
    pub mid: f64,
    pub end: f64,
    pub pass: f64,
    pub skip: f64,
    pub limit: f64,
    pub end_of_pass: bool,
    pub section_entry: bool,
    pub glue_from: f64,
}

impl From<&PlayItem> for WalkItem {
    fn from(it: &PlayItem) -> Self {
        WalkItem {
            mid: it.mid,
            end: it.end,
            pass: it.pass,
            skip: it.skip,
            limit: it.limit,
            end_of_pass: it.end_of_pass,
            section_entry: it.section_entry,
            glue_from: it.glue_from,
        }
    }
}

/// 走出来的一步。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Step {
    /// 放一个小节：`skip` 首小节跳过前几个和弦、`limit` 末小节只取前几个（-1 = 整节）、`last` 整首最后一小节、
    /// `glue` 接在前一小节同一行；`item` 是它出自第几项（`P:` 段落的小节集合由消费者按项取）
    Measure { mid: f64, pass: f64, skip: f64, limit: f64, last: bool, glue: bool, item: usize },
    /// 一遍唱完（投影档据此换页）
    PassEnd,
    /// 往回跳、但还是同一段词（只另起一行、不换页）；消费者不分这一种时（`jump_back` 为 false）一律报 [`Step::PassEnd`]
    JumpBack,
}

/// 逐遍逐小节走。换页有两处：`end_of_pass`，以及**往回跳**（反复、D.C./D.S.）——那是新的一遍；往回跳还唱同一段词的，
/// `jump_back` 为真就只报 [`Step::JumpBack`]（投影档：一页一行的碎页，250《主，差遣我》）。遍号变了但往前接着唱的
/// （二房之后 pass 归 1 的尾段、跳过一房）不换页；同一小节被 limit / skip 切成前后两截的，后一截也是接着唱。
/// 进 `P:` 的段落不换页也不换行（换行换页看源里写的）。
pub fn walk_play(items: &[WalkItem], jump_back: bool) -> Vec<Step> {
    let mut out = Vec::new();
    let mut last_mid = -1.0;
    let mut last_pass = -1.0;
    let mut broke = true; // 刚换过页，不必再换
    for (idx, it) in items.iter().enumerate() {
        if last_mid >= 0.0 && !broke && !it.section_entry && (it.mid < last_mid || (it.mid == last_mid && it.skip == 0.0)) {
            out.push(if jump_back && it.pass == last_pass { Step::JumpBack } else { Step::PassEnd });
        }
        broke = false;
        last_pass = it.pass;
        let mut mid = it.mid;
        while mid < it.end {
            last_mid = mid;
            out.push(Step::Measure {
                mid,
                pass: it.pass,
                skip: if mid == it.mid { it.skip } else { 0.0 },
                limit: if mid == it.end - 1.0 { it.limit } else { -1.0 },
                last: mid == it.end - 1.0 && idx == items.len() - 1,
                glue: it.glue_from >= 0.0 && mid >= it.glue_from,
                item: idx,
            });
            mid += 1.0;
        }
        if it.end_of_pass {
            out.push(Step::PassEnd);
            broke = true;
        }
    }
    out
}

/// 投影档应有几遍：按 [`walk_play`] 的换页切出来、确有小节的段数（页面结构核对用）
pub fn count_passes(items: &[WalkItem]) -> usize {
    let mut n = 0;
    let mut open = false;
    for s in walk_play(items, false) {
        match s {
            Step::Measure { .. } => {
                if !open {
                    n += 1;
                }
                open = true;
            }
            _ => open = false,
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(mid: f64, end: f64, pass: f64) -> WalkItem {
        WalkItem { mid, end, pass, skip: 0.0, limit: -1.0, end_of_pass: false, section_entry: false, glue_from: -1.0 }
    }

    #[test]
    fn repeat_jumps_back() {
        // 0–2 两遍（同一段词往回跳）、再接 2–4
        let items = [item(0.0, 2.0, 1.0), item(0.0, 2.0, 1.0), item(2.0, 4.0, 1.0)];
        let s = walk_play(&items, true);
        assert_eq!(s.iter().filter(|x| matches!(x, Step::JumpBack)).count(), 1);
        assert_eq!(count_passes(&items), 2);
        let mut e = items;
        e[0].end_of_pass = true;
        assert_eq!(walk_play(&e, true).iter().filter(|x| matches!(x, Step::JumpBack)).count(), 0);
    }
}
