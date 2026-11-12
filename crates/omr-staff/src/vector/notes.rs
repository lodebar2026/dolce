//! 矢量页的**结构信息与音符候选**：字形身份直接给出「这一块是什么」（谱号、升降号、拍号数字、符头、休止、符尾、附点、奏法），
//! 其后的位置规则——行首次序（谱号 → 调号 → 拍号）、调号位置自证、挂干、成和弦、数杠、挂临时记号与附点、贴头奏法——走与位图同一份
//! （`attrs::lead` 的常数与 `Clef::key_pos`、`notes::stems::find_stem`、`notes::build_rows`、`notes::beams::tails`、
//! `notes::marks::{attach_acc, attach_dots}`、`notes::artics::{attach_fermata, attach_art}`）。
//!
//! 矢量的几何是精确的：头心就是字形框的中心，头缘就是字形框的左右缘，不用模板打分、不用拆粘连。
use super::glyphs::VSym;
use super::VecInk;
use crate::attrs::lead::{Acc, KEY_GAP, KEY_GAP_FIRST, KEY_POS_TOL};
use crate::attrs::{Change, RowAttrs};
use crate::notes::artics::{art_reach, attach_art, attach_fermata};
use crate::notes::heads::{Head, HeadKind, POS_MAX, POS_MIN};
use crate::notes::marks::{attach_acc, attach_dots};
use crate::notes::resolve::Claims;
use crate::notes::rests::Rest;
use crate::notes::stems::{find_stem, Stem};
use crate::notes::{beams, build_rows, RowNotes};
use crate::page::Layout;
use dolce_omr_sheet::music::{Clef, Key, Time, TimeSymbol};
use dolce_omr_sheet::score::{Art, Attrs, NoteType};

/// 头干尾一体的字形（`metNote*`）：头宽（相对线距，SMuFL 实心符头宽 1.18 格）；头心在谱表上方不出这么多个音级（再高的是速度记号里的音符）。
const HEAD_W: f64 = 1.18;
const MET_POS_MIN: f64 = -5.0;
/// 谱号要在谱行左端这么多格以内起头（同位图）。
const CLEF_WITHIN: f64 = 4.0;
/// 拍号离前一个记号最多隔这么多格（同位图）。
const TIME_GAP: f64 = 3.0;
/// 临时记号离它的符头最多几格（记号右缘到符头左缘），与符头差不过几个音级（TS 转曲路：中心同高、差不过 0.35 格）。
const TEMP_ACC_DX: f64 = 1.2;
const TEMP_ACC_POS: f64 = 0.7;
/// 符杠原语不薄于这么多（相对线距；同位图数杠的厚度下限）。
const BAND_MIN: f64 = 0.18;
/// 字号小于本页符头字号中位数的这个比例的符头是倚音。
const GRACE_EM: f64 = 0.8;
/// 行中的调号串紧跟在小节线（或换谱号）之后这么多格以内。
const MID_KEY_GAP: f64 = 2.0;
/// 行中调号串的右缘离下一个符头至少这么多格：紧贴符头的是那个音的临时记号。
const MID_KEY_CLEAR: f64 = 0.8;

/// 字形归哪一行谱：音级位置落在 [lo, hi] 里、离谱表中线最近的那一行；横向要在谱行左右端（放宽一格）之内。
fn staff_of(f: &Layout, s: &VSym, lo: f64, hi: f64) -> Option<usize> {
    let (cx, cy) = (s.cx(), s.cy());
    (0..f.staves.len())
        .filter(|&i| {
            let st = &f.staves[i];
            let p = st.pos(cx, cy);
            cx >= st.left - st.space() && cx <= st.right + st.space() && p >= lo && p <= hi
        })
        .min_by(|&a, &b| (f.staves[a].pos(cx, cy) - 4.0).abs().total_cmp(&(f.staves[b].pos(cx, cy) - 4.0).abs()))
}

fn clef_of(name: &str, f: &Layout, si: usize, s: &VSym) -> Option<Clef> {
    Some(match name {
        "gClef" => Clef::TREBLE,
        "gClef8vb" => Clef::TREBLE_8VB,
        "fClef" => Clef::BASS,
        // 中音谱号的中心指着第三线（位置 4）是中音、第四线（位置 2）是次中音
        "cClef" => {
            if f.staves[si].pos(s.cx(), s.cy()) < 3.0 { Clef::TENOR } else { Clef::ALTO }
        }
        "unpitchedPercussionClef1" | "unpitchedPercussionClef2" => Clef::PERCUSSION,
        _ => return None,
    })
}

fn acc_of(name: &str) -> Option<Acc> {
    match name {
        "accidentalSharp" => Some(Acc::Sharp),
        "accidentalFlat" => Some(Acc::Flat),
        "accidentalNatural" => Some(Acc::Natural),
        _ => None,
    }
}

/// 升降号指着的音级：升号、还原号是中心，降号是肚子（字形框下沿往上半格，同位图的 `acc_pos`）。
fn acc_pos(f: &Layout, si: usize, s: &VSym, kind: Acc) -> f64 {
    let st = &f.staves[si];
    match kind {
        Acc::Flat => st.pos(s.cx(), s.rect.bottom()) - 1.0,
        _ => st.pos(s.cx(), s.cy()),
    }
}

fn is_head(name: &str) -> bool {
    matches!(name, "noteheadBlack" | "noteheadHalf" | "noteheadWhole" | "noteheadDoubleWhole")
}

/// 调号串：从 `start` 起往右按位置自证一个挨一个接（升降都试，取接得多的）；回 (升降数, 右缘, 用掉的字形下标)。
/// 遇到符头（`stop`）或位置对不上就断。
fn key_chain(f: &Layout, si: usize, clef: Clef, syms: &[&VSym], start: f64, first_gap: f64, stop: f64) -> (i8, f64, Vec<usize>) {
    let sp = f.staves[si].space();
    let mut best = (0i8, start, Vec::new());
    for sharp in [true, false] {
        let (mut n, mut right, mut used) = (0usize, start, Vec::new());
        for (k, s) in syms.iter().enumerate() {
            if s.rect.x < start - sp * 0.3 || s.rect.x >= stop {
                continue;
            }
            let Some(kind) = acc_of(s.name) else { continue };
            let gap = if n == 0 { first_gap } else { KEY_GAP };
            // 调号一个比一个靠右（和弦前竖排着的几个临时记号横向叠在一处）
            if s.rect.x - right > sp * gap || n >= 7 || (n > 0 && s.rect.x < right - s.rect.w * 0.5) {
                break;
            }
            let want = clef.key_pos(sharp, n);
            let fits = kind == if sharp { Acc::Sharp } else { Acc::Flat } && want.is_some_and(|w| (acc_pos(f, si, s, kind) - w as f64).abs() <= KEY_POS_TOL);
            if !fits {
                break;
            }
            n += 1;
            right = s.rect.right();
            used.push(k);
        }
        if n > best.0.unsigned_abs() as usize {
            best = (if sharp { n as i8 } else { -(n as i8) }, right, used);
        }
    }
    best
}

/// 拍号：`[x0, x1]` 一带上下叠着的数字（上半在第三线以上、下半在以下），或骑中线的 C / ¢。回 (拍号, 右缘, 用掉的下标)。
fn time_at(f: &Layout, si: usize, syms: &[&VSym], x0: f64, x1: f64) -> Option<(Time, f64, Vec<usize>)> {
    let st = &f.staves[si];
    let cands: Vec<usize> = (0..syms.len()).filter(|&k| syms[k].rect.x >= x0 && syms[k].rect.x <= x1 && (syms[k].name.starts_with("timeSig"))).collect();
    let first = *cands.iter().min_by(|&&a, &&b| syms[a].rect.x.total_cmp(&syms[b].rect.x))?;
    let s0 = syms[first];
    match s0.name {
        "timeSigCommon" => return Some((Time { beats: 4, beat_type: 4, symbol: TimeSymbol::Common }, s0.rect.right(), vec![first])),
        "timeSigCutCommon" => return Some((Time { beats: 2, beat_type: 2, symbol: TimeSymbol::Cut }, s0.rect.right(), vec![first])),
        _ => {}
    }
    // 与第一个数字横向交叠的一列（两位数的分子分母各两个字）
    let col: Vec<usize> = cands.iter().copied().filter(|&k| syms[k].rect.x <= s0.rect.right() + st.space() * 0.6 && syms[k].name.len() == 8).collect();
    let digit = |k: usize| syms[k].name.as_bytes()[7].wrapping_sub(b'0') as u32;
    let (mut top, mut bot): (Vec<usize>, Vec<usize>) = col.iter().partition(|&&k| st.pos(syms[k].cx(), syms[k].cy()) < 4.0);
    top.sort_by(|&a, &b| syms[a].rect.x.total_cmp(&syms[b].rect.x));
    bot.sort_by(|&a, &b| syms[a].rect.x.total_cmp(&syms[b].rect.x));
    let num = |v: &[usize]| v.iter().try_fold(0u32, |acc, &k| (digit(k) <= 9).then(|| acc * 10 + digit(k)));
    let t = crate::attrs::lead::time_from(num(&top).filter(|_| !top.is_empty()), num(&bot).filter(|_| !bot.is_empty()))?;
    let right = col.iter().map(|&k| syms[k].rect.right()).fold(f64::MIN, f64::max);
    Some((t, right, col))
}

/// 一页各行谱的结构信息（行首 + 行中切换），再同系统互证（与位图同一份 `attrs::agree`）。
/// `lead`：字形字典在行首认不出谱号的行（转曲页换了一套字体）改走的行首读法（见 `vector::raster_frame`），读出谱号就用它的谱号 / 调号 / 拍号；
/// 这样的行，行中小节线后字典认不出的拍号也走同一份位图读法（`mid_time(行, 起, 止)`，裴克经文诗歌 036 中途换 3/4）。
pub fn page_attrs(f: &Layout, syms: &[VSym], lead: Option<&dyn Fn(usize) -> RowAttrs>, mid_time: Option<&dyn Fn(usize, f64, f64) -> Option<Time>>) -> Vec<RowAttrs> {
    let mut rows: Vec<RowAttrs> = Vec::with_capacity(f.staves.len());
    for si in 0..f.staves.len() {
        let st = &f.staves[si];
        let sp = st.space();
        let mut mine: Vec<&VSym> = syms.iter().filter(|s| staff_of(f, s, -6.0, 14.0) == Some(si)).collect();
        mine.sort_by(|a, b| a.rect.x.total_cmp(&b.rect.x));
        let head_x = |from: f64| mine.iter().filter(|s| is_head(s.name) && s.rect.x > from).map(|s| s.rect.x).fold(f64::MAX, f64::min);
        let mut out = RowAttrs { lead_end: st.left, ..Default::default() };
        let mut right = st.left;
        let mut clef = None;
        if let Some(s) = mine.iter().find(|s| s.rect.x <= st.left + sp * CLEF_WITHIN && clef_of(s.name, f, si, s).is_some()) {
            let mut c = clef_of(s.name, f, si, s).unwrap();
            // 高音谱号下面另有一个小 8
            if c == Clef::TREBLE && mine.iter().any(|d| d.name == "clef8" && d.cx() >= s.rect.x && d.cx() <= s.rect.right() && d.cy() > s.cy()) {
                c = Clef::TREBLE_8VB;
            }
            out.clef = Some(c);
            out.clef_sure = true;
            out.clef_box = Some(s.rect);
            right = s.rect.right();
            clef = Some(c);
        }
        let fell = match lead.filter(|_| clef.is_none()).map(|g| g(si)).filter(|r| r.clef.is_some()) {
            Some(r) => {
                clef = r.clef;
                right = r.lead_end;
                out = RowAttrs { changes: Vec::new(), ..r };
                true
            }
            None => false,
        };
        if !fell {
            if let Some(c) = clef.filter(|c| *c != Clef::PERCUSSION) {
                let (n, r, _) = key_chain(f, si, c, &mine, right, KEY_GAP_FIRST, head_x(right));
                out.key = Some(Key { fifths: n });
                out.key_sure = true;
                right = right.max(r);
            }
            let end = f.bars[si].iter().map(|b| b.x0).find(|&x| x > right + sp).unwrap_or(f64::MAX).min(head_x(right)).min(st.left + sp * 14.0);
            if let Some((t, r, _)) = time_at(f, si, &mine, right - sp * 0.2, end.min(right + sp * TIME_GAP)) {
                out.time = Some(t);
                right = right.max(r);
            }
        }
        out.lead_end = right;
        // 行中切换：行首区之后的谱号、小节线（或换谱号）后紧跟的调号串（还原号串清掉旧调）、拍号
        let mut changes: Vec<Change> = Vec::new();
        let mut cur_clef = clef;
        for s in mine.iter().filter(|s| s.rect.x > right + sp * 0.5) {
            if let Some(c) = clef_of(s.name, f, si, s) {
                cur_clef = Some(c);
                changes.push(Change { x: s.cx(), attrs: Attrs { clef: Some(c), key: None, time: None, staff: 0 } });
            }
        }
        if let Some(c) = cur_clef.or(clef).filter(|c| *c != Clef::PERCUSSION) {
            for b in f.bars[si].iter().filter(|b| b.x > right + sp) {
                let start = b.x1;
                // 行末的提示调号、拍号（后面本行没有音了，下一行行首自己读）不收
                if head_x(start) == f64::MAX {
                    continue;
                }
                // 右边紧挨着一个同高符头的升降号是那个音的临时记号，调号串到它为止（C 调曲子小节线后的临时还原 / 升号不当转调）
                let temp = |s: &VSym| {
                    acc_of(s.name).is_some_and(|k| {
                        let p = acc_pos(f, si, s, k);
                        mine.iter().any(|h| is_head(h.name) && h.rect.x >= s.rect.right() - sp * 0.2 && h.rect.x <= s.rect.right() + sp * TEMP_ACC_DX && (st.pos(h.cx(), h.cy()) - p).abs() < TEMP_ACC_POS)
                    })
                };
                let after: Vec<&VSym> = mine.iter().copied().filter(|s| s.rect.x > start && s.rect.x < start + sp * 8.0).take_while(|s| !temp(s)).collect();
                // 还原号串
                let nat: Vec<&&VSym> = after.iter().take_while(|s| s.name == "accidentalNatural").collect();
                let from = nat.last().map_or(start, |s| s.rect.right());
                if nat.first().is_some_and(|s| s.rect.x - start > sp * MID_KEY_GAP) {
                    continue;
                }
                let (n, r, _) = key_chain(f, si, c, &after, from, if nat.is_empty() { MID_KEY_GAP } else { KEY_GAP }, head_x(start));
                if n != 0 && head_x(start) - r < sp * MID_KEY_CLEAR {
                    continue;
                }
                if n != 0 || !nat.is_empty() {
                    changes.push(Change { x: b.x + 0.5, attrs: Attrs { clef: None, key: Some(Key { fifths: n }), time: None, staff: 0 } });
                    if let Some((t, _, _)) = time_at(f, si, &after, r - sp * 0.2, r + sp * TIME_GAP) {
                        changes.push(Change { x: b.x + 0.6, attrs: Attrs { clef: None, key: None, time: Some(t), staff: 0 } });
                    }
                } else if let Some(t) = time_at(f, si, &after, start, start + sp * TIME_GAP)
                    .map(|(t, _, _)| t)
                    .or_else(|| mid_time.filter(|_| fell).and_then(|g| g(si, start, (start + sp * TIME_GAP).min(head_x(start)))))
                {
                    changes.push(Change { x: b.x + 0.6, attrs: Attrs { clef: None, key: None, time: Some(t), staff: 0 } });
                }
            }
        }
        changes.sort_by(|a, b| a.x.total_cmp(&b.x));
        out.changes = changes;
        rows.push(out);
    }
    crate::attrs::agree::system_agree(f, &mut rows);
    rows
}

/// 一页各行谱的音符：符头、干（位图同一份 `find_stem`，探针换成矢量的）、成和弦、休止、杠与尾、临时记号、附点、贴头奏法。
pub fn page_notes(f: &Layout, ink: &VecInk, attrs: &[RowAttrs], syms: &[VSym]) -> Vec<RowNotes> {
    let claims = Claims::new(f);
    let mut all: Vec<(Head, Option<Stem>)> = Vec::new();
    // 同一个符头印了两遍（同一字形、同一位置）只收一个
    let mut seen: Vec<(i64, i64, &str)> = Vec::new();
    // 倚音：字号比本页符头字号的中位数小两成以上（与本页同类比，不设绝对值）；现在不出倚音（位图路同），先不收
    let ems: Vec<f64> = syms.iter().filter(|s| is_head(s.name)).map(|s| s.em).collect();
    let grace_em = dolce_omr_core::geom::median(&ems, 0.0) * GRACE_EM;
    for s in syms.iter().filter(|s| is_head(s.name) && s.em >= grace_em) {
        let Some(si) = staff_of(f, s, POS_MIN as f64 - 0.5, POS_MAX as f64 + 0.5) else { continue };
        let st = &f.staves[si];
        let from = attrs.get(si).map_or(st.left, |a| a.lead_end);
        if s.cx() < from {
            continue;
        }
        let key = ((s.cx() * 2.0).round() as i64, (s.cy() * 2.0).round() as i64, s.name);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let (x, y) = (s.cx(), s.cy());
        let kind = match s.name {
            "noteheadBlack" => HeadKind::Filled,
            "noteheadHalf" => HeadKind::Half,
            _ => HeadKind::Whole,
        };
        let pos = st.pos(x, y).round() as i32;
        let h = Head { staff: si, x, y, pos, kind, fill: 1.0, score: 1.0, acc: None, rid: None };
        let stem = (kind != HeadKind::Whole).then(|| find_stem(ink, &h, st.space(), f.unit.thick, Some((s.rect.x.floor() as i64, s.rect.right().ceil() as i64)), &|x| claims.bar_col(si, x))).flatten();
        all.push((h, stem));
    }
    // 整个音画成一个速度记号字形的（Anastasia 的 `metNote8thUp` 一族：头 + 干 + 尾一体）：按字形几何拆成头与干，尾数照名字。
    // 谱表上方远处的才是速度记号里的音符，不收
    let mut fused_tails: Vec<(f64, f64, u8)> = Vec::new();
    for s in syms.iter().filter(|s| s.name.starts_with("metNote")) {
        let Some(si) = staff_of(f, s, MET_POS_MIN, POS_MAX as f64 + 0.5) else { continue };
        let st = &f.staves[si];
        let sp = st.space();
        if s.cx() < attrs.get(si).map_or(st.left, |a| a.lead_end) {
            continue;
        }
        let up = !s.name.ends_with("Down");
        let (hw, hh) = (HEAD_W * sp, sp);
        let (x, y) = (s.rect.x + hw / 2.0, if up { s.rect.bottom() - hh / 2.0 } else { s.rect.y + hh / 2.0 });
        let kind = if s.name.contains("Half") { HeadKind::Half } else { HeadKind::Filled };
        let pos = st.pos(x, y).round() as i32;
        let h = Head { staff: si, x, y, pos, kind, fill: 1.0, score: 1.0, acc: None, rid: None };
        let sx = if up { s.rect.x + hw - f.unit.thick / 2.0 } else { s.rect.x + f.unit.thick / 2.0 };
        let stem = Stem { x: sx.round() as i64, top: s.rect.y.round() as i64, bottom: s.rect.bottom().round() as i64, up };
        let tails = match s.name {
            n if n.contains("8th") => 1,
            n if n.contains("16th") => 2,
            n if n.contains("32nd") => 3,
            _ => 0,
        };
        fused_tails.push((x, y, tails));
        all.push((h, Some(stem)));
    }
    let mut rows = build_rows(f, ink, all);
    // 休止
    for s in syms.iter() {
        let ntype = match s.name {
            // 全休止与二分休止常是同一个方块字形，按位置分：挂在第四线下（顶边贴第四线）的是全休止，坐在第三线上（底边贴第三线）的是二分休止
            "restWhole" | "restHalf" => match staff_of(f, s, -6.0, 14.0).map(|si| &f.staves[si]) {
                Some(st) if (s.rect.y - st.y_of(s.cx(), 2.0)).abs() < (s.rect.bottom() - st.y_of(s.cx(), 4.0)).abs() => NoteType::Whole,
                Some(_) => NoteType::Half,
                None if s.name == "restWhole" => NoteType::Whole,
                None => NoteType::Half,
            },
            "restHBar" | "restDoubleWhole" => NoteType::Whole,
            "restQuarter" => NoteType::Quarter,
            "rest8th" => NoteType::Eighth,
            "rest16th" => NoteType::N16th,
            "rest32nd" | "rest64th" => NoteType::N32nd,
            _ => continue,
        };
        let Some(si) = staff_of(f, s, -6.0, 14.0) else { continue };
        let st = &f.staves[si];
        if s.cx() < attrs.get(si).map_or(st.left, |a| a.lead_end) {
            continue;
        }
        let r = &mut rows[si].rests;
        if r.iter().any(|o| (o.x - s.cx()).abs() < 0.5 && (o.y - s.cy()).abs() < 0.5) {
            continue;
        }
        r.push(Rest { staff: si, x: s.cx(), y: s.cy(), ntype, rect: (s.rect.x, s.rect.y, s.rect.w, s.rect.h), dots: 0, arts: Vec::new(), measures: 0, rid: None, pinned: false });
    }
    for row in rows.iter_mut() {
        row.rests.sort_by(|a, b| a.x.total_cmp(&b.x));
    }
    // 杠与尾：位图同一份数杠；没杠的干，条数只按贴着干端的符尾字形给（字形身份确定；压在干端的连音数字、括线不是尾）
    beams::tails(&ink.bands_only(f.unit.space * BAND_MIN), &mut rows, &f.staves, f.unit.thick);
    for (si, row) in rows.iter_mut().enumerate() {
        let sp = f.staves[si].space();
        for c in row.chords.iter_mut().filter(|c| !c.beamed) {
            let Some(st) = c.stem else { continue };
            let tip = if st.up { st.top } else { st.bottom } as f64;
            let n = syms
                .iter()
                .filter(|s| s.name.starts_with("flag"))
                .filter(|s| s.rect.x >= st.x as f64 - sp * 0.3 && s.rect.x <= st.x as f64 + sp * 0.3 && tip >= s.rect.y - sp * 0.5 && tip <= s.rect.bottom() + sp * 0.5)
                .map(|s| match s.name {
                    n if n.starts_with("flag8th") => 1,
                    n if n.starts_with("flag16th") => 2,
                    n if n.starts_with("flag32nd") => 3,
                    _ => 4,
                })
                .max();
            c.tails = n.unwrap_or(0);
            // 头干尾一体的字形：尾数照名字
            if let Some(&(_, _, t)) = fused_tails.iter().find(|(x, y, _)| c.heads.iter().any(|h| (h.x - x).abs() < 0.5 && (h.y - y).abs() < 0.5)) {
                c.tails = c.tails.max(t);
            }
        }
    }
    // 临时记号（调号与行中调号串用掉的不算：它们在行首区之内或紧跟小节线，右边挂不上头）、附点、奏法
    for (si, row) in rows.iter_mut().enumerate() {
        let st = &f.staves[si];
        let sp = st.space();
        let from = attrs.get(si).map_or(st.left, |a| a.lead_end);
        for s in syms.iter().filter(|s| s.cx() > from) {
            if let Some(kind) = acc_of(s.name) {
                if staff_of(f, s, POS_MIN as f64, POS_MAX as f64) == Some(si) {
                    let ok = attach_acc(row, s.rect, acc_pos(f, si, s, kind), kind, sp);
                    if std::env::var("OMR_VEC_DEBUG").is_ok() {
                        eprintln!("记号 {} 行{si} x{:.0} y{:.0} 位{:.1} 挂{ok}", s.name, s.cx(), s.cy(), acc_pos(f, si, s, kind));
                    }
                    if !ok && std::env::var("OMR_VEC_DEBUG").is_ok() {
                        let near: Vec<String> = row.chords.iter().flat_map(|c| c.heads.iter()).filter(|h| (h.x - s.rect.right()).abs() < sp * 4.0).map(|h| format!("({:.0},{} gap {:.2})", h.x, h.pos, (h.x - 0.6 * sp - s.rect.right()) / sp)).collect();
                        eprintln!("挂不上 {} 行{si} x{:.0} 位{:.1} 邻头 {near:?}", s.name, s.cx(), acc_pos(f, si, s, kind));
                    }
                }
            }
        }
        let dots = syms.iter().filter(|s| s.name == "augmentationDot" && s.cx() > from && staff_of(f, s, POS_MIN as f64, POS_MAX as f64) == Some(si)).map(|s| (s.cx(), s.cy()));
        attach_dots(f, si, row, dots);
        for s in syms.iter().filter(|s| s.cx() > from && staff_of(f, s, -12.0, 20.0) == Some(si)) {
            let kind = match s.name {
                n if n.starts_with("articStaccatissimo") => Art::Staccatissimo,
                n if n.starts_with("articStaccato") => Art::Staccato,
                n if n.starts_with("articTenuto") && !n.contains("Staccato") => Art::Tenuto,
                n if n.starts_with("articAccent") || n.starts_with("articMarcato") => Art::Accent,
                _ => continue,
            };
            let (dx, gap) = art_reach(kind);
            attach_art(row, sp, kind, s.cx(), s.cy(), s.rect, dx, gap);
        }
    }
    // 连音：文字层里的「3」（正文字体）或音乐字体的 tuplet3，按位图同一份成组规则找正对着的三个和弦
    let threes: Vec<dolce_omr_core::image::Rect> = vp_threes(ink.vp).into_iter().chain(syms.iter().filter(|s| s.name == "tuplet3").map(|s| s.rect)).collect();
    for (si, row) in rows.iter_mut().enumerate() {
        let mut found: Vec<crate::notes::tuplets::TupletCand> = Vec::new();
        for r in threes.iter().filter(|r| staff_of_point(f, r.cx(), r.y + r.h / 2.0) == Some(si)) {
            if let Some(w) = crate::notes::tuplets::group_at(f, si, row, *r) {
                if !found.iter().any(|t| t.chords.iter().any(|i| w.contains(i))) {
                    found.push(crate::notes::tuplets::TupletCand { chords: w, actual: 3, normal: 2 });
                }
            }
        }
        row.tuplets = found;
    }
    for s in syms.iter().filter(|s| s.name.starts_with("fermata")) {
        attach_fermata(f, &mut rows, s.rect, s.name == "fermataAbove");
    }
    rows
}

/// 文字层里单独的「3」（非音乐字体；左右没有紧挨着的字，不是歌词、和弦里的一部分）。
fn vp_threes(vp: &dolce_omr_source::vector::VecPage) -> Vec<dolce_omr_core::image::Rect> {
    let cs = &vp.chars;
    (0..cs.len())
        .filter(|&i| cs[i].unicode == '3' as u32 && super::glyphs::music_family(&cs[i].font).is_none())
        .filter(|&i| {
            let c = &cs[i];
            let lone = |j: usize| cs.get(j).is_none_or(|d| d.generated || (d.bbox.x - c.bbox.x).abs() > c.size_scaled * 1.2 || (d.bbox.y - c.bbox.y).abs() > c.size_scaled);
            (i == 0 || lone(i - 1)) && lone(i + 1)
        })
        .map(|i| vp.rect_of(&cs[i].bbox))
        .collect()
}

/// 点归哪一行谱（音级位置 −12 ~ 20 里离中线最近的）。
fn staff_of_point(f: &Layout, x: f64, y: f64) -> Option<usize> {
    (0..f.staves.len())
        .filter(|&i| {
            let st = &f.staves[i];
            let p = st.pos(x, y);
            x >= st.left - st.space() && x <= st.right + st.space() && (-12.0..=20.0).contains(&p)
        })
        .min_by(|&a, &b| (f.staves[a].pos(x, y) - 4.0).abs().total_cmp(&(f.staves[b].pos(x, y) - 4.0).abs()))
}
