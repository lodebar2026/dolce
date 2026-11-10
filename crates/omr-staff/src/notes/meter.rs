//! **满拍裁决**（3.9）：一个系统逐小节验各行的拍数（[`dolce_omr_sheet::meter`] 的时间线），不满的在把握不大的元素的备选里
//! 选一组使本小节满拍、且与同系统别的行拍位对齐的；选出来的以**修正提案**（[`Fix`]）交回，由 [`apply`] 统一落到音符上。
//! 凑不满的保持原判，记可疑。别的模块（跨谱表对齐、简谱互证）要改音符也走 [`Fix`]。
use super::heads::HeadKind;
use super::{Chord, RowNotes, SAME_ONSET};
use crate::page::PageFrame;
use dolce_omr_sheet::meter::{base_line, solve, Alt, Item, Line};
use dolce_omr_sheet::score::{DoubtKind, NoteType};

/// 各种改动的花费（越大越不情愿；只用来在几种改法之间排先后）：加一条符尾、删休止、删和弦。
const COST_TAIL: f64 = 1.2;
const COST_DROP_REST: f64 = 1.5;
const COST_DROP: f64 = 2.0;
/// 模板分比本页中位数低 `LOW_SPAN` 的实心头，删它的花费降到 `COST_DROP_LOW`（之间线性）；
/// 低不到一半的头把握大，不为凑满拍删它。
const COST_DROP_LOW: f64 = 0.8;
const LOW_SPAN: f64 = 0.2;

/// 改哪个元素（行内下标）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Chord(usize),
    Rest(usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Dots(u8),
    Tails(u8),
    Kind(HeadKind),
    RestType(NoteType),
    Drop,
}

/// 一条修正提案。`row`：调用方那组行里的第几行。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fix {
    pub row: usize,
    pub target: Target,
    pub op: Op,
}

/// 把提案落到音符上（删除放在最后、从后往前删，前面的下标不动）。
pub fn apply(rows: &mut [RowNotes], fixes: &[Fix]) {
    for f in fixes {
        let row = &mut rows[f.row];
        match (f.target, f.op) {
            (Target::Chord(i), Op::Dots(d)) => row.chords[i].dots = d,
            (Target::Chord(i), Op::Tails(t)) => row.chords[i].tails = t,
            (Target::Chord(i), Op::Kind(k)) => {
                let c = &mut row.chords[i];
                c.heads.iter_mut().for_each(|h| h.kind = k);
                if k != HeadKind::Filled {
                    c.tails = 0;
                }
            }
            (Target::Rest(i), Op::Dots(d)) => row.rests[i].dots = d,
            (Target::Rest(i), Op::RestType(t)) => row.rests[i].ntype = t,
            _ => {}
        }
    }
    let mut drops: Vec<(usize, Target)> = fixes.iter().filter(|f| f.op == Op::Drop).map(|f| (f.row, f.target)).collect();
    drops.sort_by_key(|(r, t)| match t {
        Target::Chord(i) => (*r, 0, std::cmp::Reverse(*i)),
        Target::Rest(i) => (*r, 1, std::cmp::Reverse(*i)),
    });
    drops.dedup();
    for (r, t) in drops {
        match t {
            Target::Chord(i) => {
                rows[r].chords.remove(i);
            }
            Target::Rest(i) => {
                rows[r].rests.remove(i);
            }
        }
    }
}

/// 一个小节的上下文。
#[derive(Clone, Copy, Debug)]
pub struct Bar {
    /// 这一小节该有多少份；拍号不明为 None（不验）。
    pub want: Option<u32>,
    /// 可以不满的小节（曲首弱起、行末劈开的半截、段落线两侧）：不足不改、不记可疑。
    pub loose: bool,
}

/// 一处可疑（系统内坐标，调用方补页码、小节号）。
#[derive(Clone, Debug)]
pub struct Flag {
    pub row: usize,
    pub bar: usize,
    pub kind: DoubtKind,
    pub note: String,
}

/// 满拍读数。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// 验过的（行 × 小节，有内容、拍号已知）。
    pub checked: usize,
    /// 原判就满拍（含各行一致的不完整小节）。
    pub full_before: usize,
    /// 裁决后满拍。
    pub full_after: usize,
    /// 改过的。
    pub fixed: usize,
}

impl std::ops::AddAssign for Stats {
    fn add_assign(&mut self, o: Self) {
        self.checked += o.checked;
        self.full_before += o.full_before;
        self.full_after += o.full_after;
        self.fixed += o.fixed;
    }
}

pub fn chord_dur(c: &Chord) -> u32 {
    c.ntype().dotted(c.dots)
}

/// 一个和弦的备选。`med`：本页实心头模板分的中位数。
///
/// 只出「缩短 / 删掉」的备选：不满拍的小节多半是漏了音，把现有的音拉长去凑（补附点、去符尾、实心改空心）量下来净亏；
/// 去附点、空心改实心、全休止改二分也净亏或无益，暂不出（[`Op`] 留着这几种，别的模块有证据时可以提）。
fn chord_alts(c: &Chord, med: f64) -> Vec<(Op, Alt)> {
    let mut v = Vec::new();
    if c.kind() != HeadKind::Filled {
        return v;
    }
    if c.tails < 3 {
        let mut t = c.clone();
        t.tails += 1;
        v.push((Op::Tails(t.tails), Alt { dur: Some(chord_dur(&t)), cost: COST_TAIL }));
    }
    let s = c.heads.iter().map(|h| h.score).fold(0.0, f64::max);
    let low = ((med - s) / LOW_SPAN).clamp(0.0, 1.0);
    if low > 0.5 {
        v.push((Op::Drop, Alt { dur: None, cost: COST_DROP - (COST_DROP - COST_DROP_LOW) * low }));
    }
    v
}

/// 全休止占满整小节。
pub fn rest_dur(t: NoteType, dots: u8, want: u32) -> u32 {
    if t == NoteType::Whole { want } else { t.dotted(dots) }
}

fn rest_alts() -> Vec<(Op, Alt)> {
    vec![(Op::Drop, Alt { dur: None, cost: COST_DROP_REST })]
}

/// 一行一个小节的元素与各备选对应的改动。
struct Cell {
    items: Vec<Item>,
    ops: Vec<(Target, Vec<Op>)>,
    line: Line,
    dx: f64,
}

/// 一个系统的满拍裁决。`rows`：这个系统各行谱的页内下标；`notes`：与 `rows` 同序的各行音符（就地改）；
/// `bar_of`：x → 第几小节；`bars`：各小节的上下文。回可疑清单与读数。
pub fn settle_system(f: &PageFrame, rows: &[usize], notes: &mut [RowNotes], bar_of: &dyn Fn(f64) -> usize, bars: &[Bar], med: f64) -> (Vec<Flag>, Stats) {
    let mut flags = Vec::new();
    let mut stats = Stats::default();
    let mut fixes: Vec<Fix> = Vec::new();
    for (j, bar) in bars.iter().enumerate() {
        let Some(want) = bar.want else { continue };
        let mut cells: Vec<Option<Cell>> = Vec::new();
        for (k, &si) in rows.iter().enumerate() {
            let dx = SAME_ONSET * f.staves[si].space();
            let row = &notes[k];
            let mut both: Vec<(Item, Target, Vec<Op>)> = Vec::new();
            for (i, c) in row.chords.iter().enumerate().filter(|(_, c)| bar_of(c.x) == j) {
                let (ops, alts): (Vec<Op>, Vec<Alt>) = chord_alts(c, med).into_iter().unzip();
                let y = c.heads.iter().map(|h| h.y).sum::<f64>() / c.heads.len() as f64;
                both.push((Item { x: c.x, y, dur: chord_dur(c), up: c.stem.map(|s| s.up), alts }, Target::Chord(i), ops));
            }
            for (i, r) in row.rests.iter().enumerate().filter(|(_, r)| bar_of(r.x) == j) {
                let (ops, alts): (Vec<Op>, Vec<Alt>) = rest_alts().into_iter().unzip();
                both.push((Item { x: r.x, y: r.y, dur: rest_dur(r.ntype, r.dots, want), up: None, alts }, Target::Rest(i), ops));
            }
            if both.is_empty() {
                cells.push(None);
                continue;
            }
            both.sort_by(|a, b| a.0.x.total_cmp(&b.0.x));
            let (items, ops): (Vec<Item>, Vec<(Target, Vec<Op>)>) = both.into_iter().map(|(it, t, o)| (it, (t, o))).unzip();
            let line = base_line(&items, dx);
            cells.push(Some(Cell { items, ops, line, dx }));
        }
        let live: Vec<&Cell> = cells.iter().flatten().collect();
        if live.is_empty() {
            continue;
        }
        stats.checked += live.len();
        // 各行都排到同一处、只是不等于拍号的：真的不完整小节（弱起、段落收尾、变拍），不改
        let ends: Vec<Option<u32>> = live.iter().map(|c| c.line.even()).collect();
        if live.len() >= 2 && ends[0].is_some_and(|e| e != want) && ends.iter().all(|e| *e == ends[0]) {
            stats.full_before += live.len();
            stats.full_after += live.len();
            continue;
        }
        // 原判满拍的行作别的行的拍位参照
        let peers: Vec<(f64, u32)> = live.iter().filter(|c| c.line.fits(want)).flat_map(|c| c.line.onsets.iter().copied()).collect();
        for (k, cell) in cells.iter().enumerate() {
            let Some(cell) = cell else { continue };
            if cell.line.fits(want) {
                stats.full_before += 1;
                stats.full_after += 1;
                let others: Vec<(f64, u32)> = cells.iter().enumerate().filter(|(o, _)| *o != k).filter_map(|(_, c)| c.as_ref()).filter(|c| c.line.fits(want)).flat_map(|c| c.line.onsets.iter().copied()).collect();
                let n = cell.line.misaligned(&others, cell.dx);
                if n > 0 {
                    flags.push(Flag { row: k, bar: j, kind: DoubtKind::Misaligned, note: format!("{n} 处拍位与别的行不齐") });
                }
                continue;
            }
            let under = !cell.line.clash && cell.line.end.iter().all(|&e| e < want);
            if bar.loose && under {
                continue;
            }
            match solve(&cell.items, want, cell.dx, &peers) {
                Some(s) => {
                    stats.full_after += 1;
                    stats.fixed += 1;
                    let mut what = Vec::new();
                    for (n, p) in s.pick.iter().enumerate() {
                        if let Some(a) = p {
                            let (target, ops) = &cell.ops[n];
                            fixes.push(Fix { row: k, target: *target, op: ops[*a] });
                            what.push(format!("{:?}", ops[*a]));
                        }
                    }
                    flags.push(Flag { row: k, bar: j, kind: DoubtKind::Inferred, note: what.join("+") });
                }
                None => {
                    let over = cell.line.end.iter().any(|&e| e > want);
                    flags.push(Flag { row: k, bar: j, kind: if over { DoubtKind::Overfull } else { DoubtKind::Underfull }, note: format!("{}/{} 对 {want}", cell.line.end[0], cell.line.end[1]) });
                }
            }
        }
    }
    apply(notes, &fixes);
    (flags, stats)
}
