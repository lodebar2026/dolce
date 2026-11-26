//! 简谱行给五线谱纠错。两条路错的地方不一样：五线谱会把符头定到符干另一头、漏附点、漏贴着弧的头；简谱数字大而清楚，
//! 错的多半是个别数字。所以**音高信简谱、时值看谁跟拍号自洽**，逐小节按 x 一对一配对：
//!
//! - 配对：数字印在对应符头的正上方，扣掉全曲的横向平移后 [`PAIR_DX`] 格以内算一对；
//! - 八度：简谱只给相对八度，「1」的绝对位置由全曲配上的对投票（众数）；
//! - 只拿拍数自洽的简谱小节纠：配上的音照简谱改音高；五线谱这一小节不自洽时照简谱改时值；
//!   配上的音同一拍点上的其余头是假的（简谱是单旋律）；超拍、没配上的五线谱音删掉正好补平才删；
//!   缺拍、没配上的简谱音正好补平才补；
//! - 多声部谱表（闭合人声谱）上简谱只是最上面那个声部：只对各拍点的最高音，只收差一级的音高。
use super::{JpNote, JpRow};
use crate::notes::heads::{Head, HeadKind};
use crate::notes::meter::{chord_dur, rest_dur};
use crate::notes::rests::Rest;
use crate::notes::{Chord, RowNotes};
use dolce_omr_core::sheet::music::{Clef, Key};
use dolce_omr_core::sheet::score::{NoteType, DIVISIONS};
use dolce_omr_core::sheet::Staff;

/// 配对的 x 容差（相对线距，扣掉平移之后）。相邻两个八分音符隔一格半上下。
const PAIR_DX: f64 = 0.8;
/// 估平移时数字到最近的音最多隔这么远（相对线距）。
const SHIFT_REACH: f64 = 1.5;
/// 同一拍点：两个和弦横向相隔不到这么多（相对线距）。
const SAME_COL: f64 = 0.3;
/// 一行谱上与别的音同拍点的音过这么多成，算多声部。
const POLY_FRAC: f64 = 0.5;

/// 一行谱与它的简谱行。
#[derive(Clone, Copy)]
pub struct Ctx<'a> {
    /// 页内下标。
    pub si: usize,
    pub st: &'a Staff,
    /// 行首区右缘：左边的数字是简谱的调号拍号（`1=B 4/4`），不是音。
    pub lead: f64,
    pub jp: &'a JpRow,
    pub clef: Clef,
    pub key: Key,
}

/// 全曲的校准：数字相对符头的横向平移（相对线距）、「1」的自然音序号减去主音音级。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Calib {
    pub shift: f64,
    pub base: Option<i32>,
    /// 带简谱行的谱表是多声部的（闭合人声谱）：一半以上的和弦带着别的头，或与别的和弦同拍点。
    pub poly: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub pairs: usize,
    pub pitch: usize,
    pub duration: usize,
    pub removed: usize,
    pub inserted: usize,
}

impl std::ops::AddAssign for Stats {
    fn add_assign(&mut self, o: Self) {
        self.pairs += o.pairs;
        self.pitch += o.pitch;
        self.duration += o.duration;
        self.removed += o.removed;
        self.inserted += o.inserted;
    }
}

/// 自然音序号（八度 × 7 + 音名）。
fn dia(clef: Clef, pos: i32) -> i32 {
    let p = clef.pitch_at(pos);
    p.octave as i32 * 7 + p.step as i32
}

/// 调号那个大调的主音音级（C = 0）。简谱是首调的，小调曲子也按关系大调唱名。
fn tonic(key: Key) -> i32 {
    (key.fifths as i32 * 4).rem_euclid(7)
}

/// 数字的时值（份）：减时线逐条减半、附点、增时线各加一拍。
fn jp_dur(n: &JpNote) -> u32 {
    let base = DIVISIONS >> n.div.min(4);
    let dotted = (0..n.dots).fold((base, base), |(sum, last), _| (sum + last / 2, last / 2)).0;
    dotted + n.aug * DIVISIONS
}

/// 份数 → 基本时值与附点数；凑不成的 None。
fn type_of(d: u32) -> Option<(NoteType, u8)> {
    const TYPES: [NoteType; 6] = [NoteType::Whole, NoteType::Half, NoteType::Quarter, NoteType::Eighth, NoteType::N16th, NoteType::N32nd];
    TYPES.iter().flat_map(|t| (0..=2u8).map(move |k| (*t, k))).find(|(t, k)| t.dotted(*k) == d)
}

/// 基本时值 → 头型与符尾数。
fn shape_of(t: NoteType) -> (HeadKind, u8) {
    match t {
        NoteType::Whole => (HeadKind::Whole, 0),
        NoteType::Half => (HeadKind::Half, 0),
        NoteType::Quarter => (HeadKind::Filled, 0),
        NoteType::Eighth => (HeadKind::Filled, 1),
        NoteType::N16th => (HeadKind::Filled, 2),
        NoteType::N32nd => (HeadKind::Filled, 3),
    }
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v.get(v.len() / 2).copied().unwrap_or(0.0)
}

fn mode(v: &[i32]) -> Option<i32> {
    v.iter().copied().max_by_key(|x| (v.iter().filter(|y| *y == x).count(), -x.abs()))
}

/// 和弦里最高的头的自然音序号。
fn top_dia(c: &Chord, clef: Clef) -> i32 {
    c.heads.iter().map(|h| dia(clef, h.pos)).max().unwrap()
}

/// 简谱行的倚音挂到五线谱上：主音数字扣掉平移后配上的和弦（[`PAIR_DX`] 格以内最近的）收下它；
/// 配不上的（五线谱这里漏了头、数字与头错开）挂右边最近的和弦（[`crate::notes::graces::REACH`] 格以内），不丢。
/// 与本小节拍数自不自洽无关——倚音不占拍。音高按全曲校准落位，升降随调号。五线谱上自己认出了倚音（小号符头）的和弦不再挂。
pub fn attach_graces(c: &Ctx, notes: &mut RowNotes, cal: &Calib) -> usize {
    let had: Vec<bool> = notes.chords.iter().map(|ch| !ch.graces.is_empty()).collect();
    let Some(base) = cal.base else { return 0 };
    let sp = c.st.space();
    let off = cal.shift * sp;
    let mut n = 0;
    for g in c.jp.graces.iter().filter(|g| g.x > c.lead) {
        let x = g.x + off;
        let near = |i: &usize| (notes.chords[*i].x - x).abs();
        let idx: Vec<usize> = (0..notes.chords.len()).collect();
        let paired = idx.iter().copied().filter(|i| near(i) <= sp * PAIR_DX).min_by(|a, b| near(a).total_cmp(&near(b)));
        let right = || idx.iter().copied().filter(|&i| notes.chords[i].x >= x - sp * PAIR_DX && notes.chords[i].x - x <= sp * crate::notes::graces::REACH).min_by(|a, b| near(a).total_cmp(&near(b)));
        let Some(ci) = paired.or_else(right).filter(|&i| !had[i]) else { continue };
        let pos = dia(c.clef, 0) - (base + tonic(c.key) + g.digit as i32 - 1 + 7 * g.octave);
        notes.chords[ci].graces.push(vec![pos]);
        n += 1;
    }
    n
}

/// 全曲校准：先估平移（各数字到最近的音的 x 差取中位数），再让扣掉平移后配上的对给「1」的位置投票。
pub fn calibrate(rows: &[(Ctx, &RowNotes)]) -> Calib {
    let mut ds = Vec::new();
    for (c, n) in rows {
        let sp = c.st.space();
        let xs: Vec<f64> = n.chords.iter().map(|c| c.x).chain(n.rests.iter().map(|r| r.x)).collect();
        for j in c.jp.notes.iter().filter(|j| j.x > c.lead) {
            if let Some(d) = xs.iter().map(|x| x - j.x).min_by(|a, b| a.abs().total_cmp(&b.abs())).filter(|d| d.abs() <= sp * SHIFT_REACH) {
                ds.push(d / sp);
            }
        }
    }
    let shift = median(ds);
    let mut votes = Vec::new();
    for (c, n) in rows {
        let sp = c.st.space();
        for j in c.jp.notes.iter().filter(|j| j.x > c.lead && (1..=7).contains(&j.digit)) {
            let near = n.chords.iter().min_by(|a, b| (a.x - shift * sp - j.x).abs().total_cmp(&(b.x - shift * sp - j.x).abs()));
            if let Some(ch) = near.filter(|ch| (ch.x - shift * sp - j.x).abs() <= sp * PAIR_DX) {
                votes.push(top_dia(ch, c.clef) - (tonic(c.key) + j.digit as i32 - 1 + 7 * j.octave));
            }
        }
    }
    let (mut all, mut crowded) = (0, 0);
    for (c, n) in rows {
        let sp = c.st.space();
        all += n.chords.len();
        crowded += n.chords.iter().enumerate().filter(|(i, ch)| ch.heads.len() > 1 || n.chords.iter().enumerate().any(|(o, d)| o != *i && (d.x - ch.x).abs() < sp * SAME_COL)).count();
    }
    Calib { shift, base: mode(&votes), poly: crowded as f64 > all as f64 * POLY_FRAC }
}

/// 小节里的一个元素。
#[derive(Clone, Copy, PartialEq)]
enum It {
    Chord(usize),
    Rest(usize),
}

/// 一行谱照它的简谱行纠。`bounds`：这个系统各小节线的 x；`wants`：各小节该有多少份（拍号不明为 None，不纠）；
/// `loose`：可以不满的小节（弱起、行末劈开的半截）。
pub fn apply(c: &Ctx, notes: &mut RowNotes, bounds: &[f64], wants: &[Option<u32>], loose: &[bool], cal: &Calib) -> Stats {
    let poly = cal.poly;
    let mut stats = Stats::default();
    let sp = c.st.space();
    let off = cal.shift * sp;
    let bar_of = |x: f64| bounds.iter().filter(|b| **b < x).count().min(wants.len().saturating_sub(1));
    let mut drop_chords: Vec<usize> = Vec::new();
    let mut drop_rests: Vec<usize> = Vec::new();
    let mut new_chords: Vec<Chord> = Vec::new();
    let mut new_rests: Vec<Rest> = Vec::new();
    for (j, want) in wants.iter().enumerate() {
        let Some(full) = *want else { continue };
        let jn: Vec<&JpNote> = c.jp.notes.iter().filter(|n| n.x > c.lead && bar_of(n.x + off) == j).collect();
        if jn.is_empty() {
            continue;
        }
        let mut items: Vec<(f64, It)> = notes.chords.iter().enumerate().filter(|(_, ch)| bar_of(ch.x) == j).map(|(i, ch)| (ch.x, It::Chord(i))).collect();
        // 多声部谱表上只收独占一个拍点的休止（与音同拍点的是别的声部的）
        items.extend(notes.rests.iter().enumerate().filter(|(_, r)| bar_of(r.x) == j && !(poly && notes.chords.iter().any(|ch| (ch.x - r.x).abs() < sp * SAME_COL))).map(|(i, r)| (r.x, It::Rest(i))));
        items.sort_by(|a, b| a.0.total_cmp(&b.0));
        // 一对一配对：按 x 距离从近到远贪心
        let mut cand: Vec<(f64, usize, usize)> = Vec::new();
        for (ji, n) in jn.iter().enumerate() {
            for (ii, it) in items.iter().enumerate() {
                let dx = (it.0 - off - n.x).abs();
                if dx <= sp * PAIR_DX {
                    cand.push((dx, ji, ii));
                }
            }
        }
        cand.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut pair_of: Vec<Option<usize>> = vec![None; jn.len()];
        let mut taken = vec![false; items.len()];
        for (_, ji, ii) in cand {
            if pair_of[ji].is_none() && !taken[ii] {
                pair_of[ji] = Some(ii);
                taken[ii] = true;
            }
        }
        let mut durs: Vec<u32> = items
            .iter()
            .map(|(_, it)| match *it {
                It::Chord(i) => chord_dur(&notes.chords[i]),
                It::Rest(i) => rest_dur(notes.rests[i].ntype, notes.rests[i].dots, full),
            })
            .collect();
        let mut alive = vec![true; items.len()];
        let jsum: u32 = jn.iter().map(|n| jp_dur(n)).sum();
        let ssum = |durs: &[u32], alive: &[bool]| -> u32 { durs.iter().zip(alive).filter(|(_, a)| **a).map(|(d, _)| *d).sum() };
        // 没配上的简谱音正好补平缺口就照简谱补：音照简谱的级数与八度落位，「0」补成休止
        let mut insert = |target: u32, rests_only: bool, durs: &[u32], alive: &[bool], stats: &mut Stats| {
            let Some(base) = cal.base else { return };
            let miss: Vec<&JpNote> = jn.iter().enumerate().filter(|(ji, n)| pair_of[*ji].is_none() && (!rests_only || n.digit == 0)).map(|(_, n)| *n).collect();
            let have = ssum(durs, alive);
            if miss.is_empty() || pair_of.iter().all(|p| p.is_none()) || target <= have || miss.iter().map(|n| jp_dur(n)).sum::<u32>() != target - have {
                return;
            }
            for n in miss {
                let Some((t, dots)) = type_of(jp_dur(n)) else { continue };
                let x = n.x + off;
                if n.digit == 0 {
                    let y = c.st.y_of(x, 4.0);
                    new_rests.push(Rest { staff: c.si, x, y, ntype: t, rect: (x - sp / 2.0, y - sp / 2.0, sp, sp), dots, arts: Vec::new(), measures: 0, rid: None, pinned: false });
                } else {
                    let pos = dia(c.clef, 0) - (base + tonic(c.key) + n.digit as i32 - 1 + 7 * n.octave);
                    let (kind, tails) = shape_of(t);
                    let head = Head { staff: c.si, x, y: c.st.y_of(x, pos as f64), pos, kind, fill: 1.0, score: 1.0, acc: None, rid: None };
                    new_chords.push(Chord { x, heads: vec![head], stem: None, tails, beamed: false, dots, arts: Vec::new(), tuplet: None, pinned: false, graces: Vec::new() });
                }
                stats.inserted += 1;
            }
        };
        let partial = jsum < full;
        // 可以不满的小节两边拍数一致：照这个拍数核
        let full = if partial && loose.get(j).copied().unwrap_or(false) && jsum == ssum(&durs, &alive) { jsum } else { full };
        if jsum < full {
            // 简谱这一小节不满拍（弱起、反复线切开的半小节）：只补五线谱上没认出来的「0」
            if !poly && jn.iter().enumerate().all(|(ji, n)| n.digit == 0 || pair_of[ji].is_some()) {
                insert(jsum, true, &durs, &alive, &mut stats);
            }
            continue;
        }
        if jsum != full {
            continue;
        }
        let staff_ok = ssum(&durs, &alive) == full;
        for (ji, n) in jn.iter().enumerate() {
            let Some(ii) = pair_of[ji] else { continue };
            stats.pairs += 1;
            let It::Chord(ci) = items[ii].1 else { continue };
            if n.digit == 0 {
                continue;
            }
            let ch = &mut notes.chords[ci];
            if let Some(base) = cal.base {
                let want = base + tonic(c.key) + n.digit as i32 - 1 + 7 * n.octave;
                // 多声部只看最高音；单旋律取离简谱最近的头，其余是假头（符干另一头被当成符头）
                let hi = if poly {
                    (0..ch.heads.len()).max_by_key(|&h| dia(c.clef, ch.heads[h].pos)).unwrap()
                } else {
                    (0..ch.heads.len()).min_by_key(|&h| (dia(c.clef, ch.heads[h].pos) - want).abs()).unwrap()
                };
                let diff = want - dia(c.clef, ch.heads[hi].pos);
                // 数字没读出八度点、五线谱正好差一个八度：多半是点漏读了，不拿它改
                let missed_dot = n.octave == 0 && diff.abs() == 7;
                // 多声部只收差一级的：整八度的多半是简谱八度点靠不住，差两级以上的多半配错了对
                if diff != 0 && !missed_dot && (!poly || diff.abs() == 1) {
                    let h = &mut ch.heads[hi];
                    h.pos -= diff;
                    h.y = c.st.y_of(h.x, h.pos as f64);
                    if diff % 7 != 0 {
                        h.acc = None;
                    }
                    stats.pitch += 1;
                }
                // 两边都印了临时记号、合出来的音不一样：照简谱改（降号调里该印还原号的地方印成了升号，简谱写 ♯4）
                let h = &mut ch.heads[hi];
                if let (Some(ja), Some(sa)) = (n.acc, h.acc) {
                    let want = c.key.alter_of(c.clef.pitch_at(h.pos).step) + ja;
                    if want != sa {
                        h.acc = Some(want);
                        stats.pitch += 1;
                    }
                }
                if !poly && ch.heads.len() > 1 {
                    stats.removed += ch.heads.len() - 1;
                    let keep = ch.heads[hi].clone();
                    ch.heads = vec![keep];
                }
            }
            // 时值只在五线谱这一小节不自洽时改，且只改音符对音符的
            if !poly && !staff_ok && ch.tuplet.is_none() {
                if let Some((t, dots)) = type_of(jp_dur(n)).filter(|(t, dots)| t.dotted(*dots) != durs[ii]) {
                    let (kind, tails) = shape_of(t);
                    ch.heads.iter_mut().for_each(|h| h.kind = kind);
                    (ch.tails, ch.dots) = (tails, dots);
                    durs[ii] = t.dotted(dots);
                    stats.duration += 1;
                }
            }
        }
        if poly {
            continue;
        }
        // 配上的音同一拍点上别的和弦是假的
        for &ii in pair_of.iter().flatten() {
            let It::Chord(_) = items[ii].1 else { continue };
            for (oi, o) in items.iter().enumerate() {
                if oi != ii && alive[oi] && !taken[oi] && matches!(o.1, It::Chord(_)) && (o.0 - items[ii].0).abs() < sp * SAME_COL {
                    alive[oi] = false;
                }
            }
        }
        // 超拍：没配上的删掉正好补平才删
        let have = ssum(&durs, &alive);
        if have > full {
            let extra: Vec<usize> = (0..items.len()).filter(|&ii| alive[ii] && !taken[ii]).collect();
            if !extra.is_empty() && have - extra.iter().map(|&ii| durs[ii]).sum::<u32>() == full {
                extra.iter().for_each(|&ii| alive[ii] = false);
            }
        }
        for (ii, _) in alive.iter().enumerate().filter(|(_, a)| !**a) {
            match items[ii].1 {
                It::Chord(i) => drop_chords.push(i),
                It::Rest(i) => drop_rests.push(i),
            }
            stats.removed += 1;
        }
        insert(full, false, &durs, &alive, &mut stats);
    }
    drop_chords.sort_unstable_by(|a, b| b.cmp(a));
    drop_chords.dedup();
    // 和弦下标变了：连音候选里的下标不再作数
    if !new_chords.is_empty() || !drop_chords.is_empty() {
        notes.tuplets.clear();
    }
    drop_chords.into_iter().for_each(|i| {
        notes.chords.remove(i);
    });
    drop_rests.sort_unstable_by(|a, b| b.cmp(a));
    drop_rests.dedup();
    drop_rests.into_iter().for_each(|i| {
        notes.rests.remove(i);
    });
    notes.chords.extend(new_chords);
    notes.chords.sort_by(|a, b| a.x.total_cmp(&b.x));
    notes.rests.extend(new_rests);
    notes.rests.sort_by(|a, b| a.x.total_cmp(&b.x));
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staff() -> Staff {
        Staff { ys: [100.0, 110.0, 120.0, 130.0, 140.0], thick: [1.0; 5], curve: None, left: 0.0, right: 1000.0, one_line: false }
    }

    fn chord(x: f64, pos: &[i32]) -> Chord {
        let heads = pos.iter().map(|&p| Head { staff: 0, x, y: 100.0 + p as f64 * 5.0, pos: p, kind: HeadKind::Filled, fill: 1.0, score: 1.0, acc: None, rid: None }).collect();
        Chord { x, heads, stem: None, tails: 0, beamed: false, dots: 0, arts: Vec::new(), tuplet: None, pinned: false, graces: Vec::new() }
    }

    fn jp(xs: &[(f64, u8, i32)]) -> JpRow {
        JpRow { staff: 0, graces: Vec::new(), notes: xs.iter().map(|&(x, digit, octave)| JpNote { x, digit, octave, div: 0, dots: 0, aug: 0, acc: None }).collect() }
    }

    fn ctx<'a>(st: &'a Staff, jp: &'a JpRow) -> Ctx<'a> {
        Ctx { si: 0, st, lead: 0.0, jp, clef: Clef::TREBLE, key: Key { fifths: 0 } }
    }

    // 高音谱号：第一线 F5，C4 在 pos 10、E4 在 8、G4 在 6
    #[test]
    fn pitch_follows_jianpu_and_false_heads_go() {
        let st = staff();
        let row = jp(&[(100.0, 3, 0), (200.0, 5, 0), (300.0, 5, 0), (400.0, 1, 0)]);
        let mut notes = RowNotes { chords: vec![chord(100.0, &[8]), chord(200.0, &[1, 6]), chord(300.0, &[7]), chord(400.0, &[10])], ..Default::default() };
        let c = ctx(&st, &row);
        let cal = calibrate(&[(c, &notes)]);
        assert_eq!((cal.base, cal.poly), (Some(28), false));
        let s = apply(&c, &mut notes, &[], &[Some(4 * DIVISIONS)], &[false], &cal);
        assert_eq!(notes.chords.iter().map(|c| c.heads.iter().map(|h| h.pos).collect::<Vec<_>>()).collect::<Vec<_>>(), vec![vec![8], vec![6], vec![6], vec![10]]);
        assert_eq!((s.pairs, s.pitch, s.removed), (4, 1, 1));
    }

    #[test]
    fn missing_note_is_inserted_when_it_fills_the_bar() {
        let st = staff();
        let row = jp(&[(100.0, 1, 0), (200.0, 2, 0), (300.0, 3, 0)]);
        let mut notes = RowNotes { chords: vec![chord(100.0, &[10]), chord(300.0, &[8])], ..Default::default() };
        let cal = Calib { shift: 0.0, base: Some(28), poly: false };
        let s = apply(&ctx(&st, &row), &mut notes, &[], &[Some(3 * DIVISIONS)], &[false], &cal);
        assert_eq!(s.inserted, 1);
        assert_eq!(notes.chords.iter().map(|c| (c.x, c.heads[0].pos)).collect::<Vec<_>>(), vec![(100.0, 10), (200.0, 9), (300.0, 8)]);
        // 简谱这一小节自己不满拍的不拿它补音
        let mut short = RowNotes { chords: vec![chord(100.0, &[10]), chord(300.0, &[8])], ..Default::default() };
        let s = apply(&ctx(&st, &row), &mut short, &[], &[Some(4 * DIVISIONS)], &[false], &cal);
        assert_eq!((s.inserted, short.chords.len()), (0, 2));
    }

    #[test]
    fn duration_only_when_staff_bar_is_off() {
        let st = staff();
        let mut row = jp(&[(100.0, 1, 0), (300.0, 3, 0)]);
        row.notes[0].aug = 1;
        let cal = Calib { shift: 0.0, base: Some(28), poly: false };
        // 五线谱两个四分对 3/4 不满：照简谱把头一个改成二分
        let mut notes = RowNotes { chords: vec![chord(100.0, &[10]), chord(300.0, &[8])], ..Default::default() };
        let s = apply(&ctx(&st, &row), &mut notes, &[], &[Some(3 * DIVISIONS)], &[false], &cal);
        assert_eq!((s.duration, notes.chords[0].kind()), (1, HeadKind::Half));
    }

    #[test]
    fn polyphonic_staff_takes_only_one_step_fixes_on_top_notes() {
        let st = staff();
        // 简谱 6（A4，比最高音 G4 高一级）照改；高八度的 1（C5）差得多，不改；内声部都留着
        let row = jp(&[(100.0, 6, 0), (300.0, 1, 1)]);
        let mut notes = RowNotes { chords: vec![chord(100.0, &[6, 10]), chord(300.0, &[6, 10])], ..Default::default() };
        let cal = Calib { shift: 0.0, base: Some(28), poly: true };
        let s = apply(&ctx(&st, &row), &mut notes, &[], &[Some(2 * DIVISIONS)], &[false], &cal);
        assert_eq!(notes.chords.iter().map(|c| c.heads.iter().map(|h| h.pos).collect::<Vec<_>>()).collect::<Vec<_>>(), vec![vec![5, 10], vec![6, 10]]);
        assert_eq!((s.pitch, s.removed, s.inserted), (1, 0, 0));
    }

    #[test]
    fn accidental_follows_jianpu_when_both_print_one() {
        let st = staff();
        // F 大调：简谱 ♯4 是还原 B；五线谱 B4（pos 4）印成升号的改成还原号，没印临时记号的那个不动
        let mut row = jp(&[(100.0, 4, 0), (300.0, 4, 0)]);
        row.notes[0].acc = Some(1);
        row.notes[1].acc = Some(1);
        let mut notes = RowNotes { chords: vec![chord(100.0, &[4]), chord(300.0, &[4])], ..Default::default() };
        notes.chords[0].heads[0].acc = Some(1);
        let c = Ctx { key: Key { fifths: -1 }, ..ctx(&st, &row) };
        let cal = Calib { shift: 0.0, base: Some(28), poly: false };
        let s = apply(&c, &mut notes, &[], &[Some(2 * DIVISIONS)], &[false], &cal);
        assert_eq!((notes.chords[0].heads[0].acc, notes.chords[1].heads[0].acc, s.pitch), (Some(0), None, 1));
    }
}
