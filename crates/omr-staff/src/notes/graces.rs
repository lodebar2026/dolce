//! 倚音：小号符头挂到右边紧跟的主音上（位图、矢量两路共用）。混排页另从简谱行接（`mixed::fuse::attach_graces`）。

use super::RowNotes;

/// 倚音往右找主音最多找这么远（相对线距）。
pub const REACH: f64 = 4.0;

/// 认出的一个倚音。
#[derive(Clone, Debug)]
pub struct Grace {
    /// 中心 x（同一主音前的几个倚音按它排先后）。
    pub x: f64,
    /// 从这里往右找主音：一般就是 `x`；连杠串里各个都用串最右那个的 x（串中间夹着假音时整串仍挂到串后的主音上）。
    pub anchor: f64,
    /// 一根干上各头的谱位（倚音和弦不止一个）。
    pub pos: Vec<i32>,
}

/// 各倚音挂到锚点右边 [`REACH`] 格以内最近的和弦，按 x 自左而右记进 `Chord::graces`。
pub fn attach(row: &mut RowNotes, sp: f64, graces: &[Grace]) -> usize {
    let mut gs = graces.to_vec();
    gs.sort_by(|a, b| a.x.total_cmp(&b.x));
    let mut n = 0;
    for g in gs {
        let Some(ci) = (0..row.chords.len()).filter(|&i| row.chords[i].x > g.anchor && row.chords[i].x - g.anchor <= sp * REACH).min_by(|&a, &b| row.chords[a].x.total_cmp(&row.chords[b].x)) else { continue };
        row.chords[ci].graces.push(g.pos);
        n += 1;
    }
    n
}

/// 矢量页的小号符头（中心 x、谱位）按横向 `CHORD_DX` 格以内并成倚音和弦。
pub fn group_by_x(sp: f64, heads: &[(f64, i32)]) -> Vec<Grace> {
    let mut hs = heads.to_vec();
    hs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<Grace> = Vec::new();
    for (x, pos) in hs {
        match out.last_mut() {
            Some(g) if x - g.x <= CHORD_DX * sp => g.pos.push(pos),
            _ => out.push(Grace { x, anchor: x, pos: vec![pos] }),
        }
    }
    out
}

/// 连杠的倚音串里相邻两根干最多隔这么远（相对线距）。
const RUN_DX: f64 = 2.5;

/// 倚音和弦里各头横向相差不过这么多（相对线距；二度的两个头左右错开一个头宽）。
const CHORD_DX: f64 = 0.8;

/// 倚音符头相对本页符头的大小（种子框、找干的尺子都乘它）。
const HEAD_K: f64 = 0.65;
/// 倚音的干长（头心到干顶，相对线距）范围。
const STEM_LEN: (f64, f64) = (1.6, 3.2);
/// 倚音头宽范围（相对线距，头心上下各 0.25 格里最宽的一行）：正常的头一格多宽，只有干那么细的不是头。
const HEAD_W: (f64, f64) = (0.45, 0.95);
/// 已认出的符头横向这么近（相对线距）、音级差不过 2 的种子是那个头自己的墨。
const NEAR_HEAD: f64 = 0.9;

/// 位图页一行谱的倚音（中心 x、一根干上各头的谱位）：按本页符头缩小的种子框撑得满（[`super::heads::seeds_scaled`]），
/// 不是已认出的头、不在休止符上，头宽在 `HEAD_W` 内且比本行实心头窄到 `SMALL_OF_ROW` 以下（低清图上漏认的普通连杠音符头不比别的小），挂得上朝上的干；挂在同一根干上的头是一个倚音和弦。
/// 每根干只拿最上面那个头查（`top_ok`），过了的整根干上的头都收；干顶与邻干连着杠的是倚音串，按串里的口径查；
/// 干与头之间断开、找不着干的小头，旁边有竖笔通到串里倚音的干顶且连着杠的也收；杠接到已认出的音符干上的不收（普通连杠音符）；右边 [`REACH`] 格以内要有主音。
/// 排查用 `OMR_GRACE_DEBUG`（给目录时写出候选局部图）。
pub fn raster(f: &crate::page::PageFrame, solid: &crate::frame::ink::InkLayers, sum: &super::heads::InkSum, claims: &super::resolve::Claims, si: usize, x_from: f64, row: &RowNotes) -> Vec<Grace> {
    let sp = f.staves[si].space();
    let ink = f.stem_ink();
    let seeds: Vec<super::heads::Head> = super::heads::seeds_scaled(f, solid, sum, si, x_from, HEAD_K)
        .into_iter()
        .filter(|g| !row.chords.iter().any(|c| c.heads.iter().any(|h| (h.x - g.x).abs() < NEAR_HEAD * sp && (h.pos - g.pos).abs() <= 2)))
        .filter(|g| !row.rests.iter().any(|r| g.x >= r.rect.0 - sp * 0.2 && g.x <= r.rect.0 + r.rect.2 + sp * 0.2))
        .collect();
    // 头宽合格、挂得上朝上的干、干在头右侧的小头
    let mut cands: Vec<(super::heads::Head, super::stems::Stem)> = Vec::new();
    // 头宽合格、找不着干的（干与头之间断了一截）：等认出别的倚音后看是不是连杠串里的
    let mut orphans: Vec<super::heads::Head> = Vec::new();
    let med = row_head_w(f, sp, row);
    for g in super::heads::fullest(seeds, sp * HEAD_K) {
        let (cx, cy) = (g.x.round() as i64, g.y.round() as i64);
        let hw = head_w(f, sp, cx, cy);
        if !(HEAD_W.0..=HEAD_W.1).contains(&hw) || med.is_some_and(|m| hw > SMALL_OF_ROW * m) {
            debug(f, sp, si, cx, cy, "宽", &format!("{hw:.2}/{:.2}", med.unwrap_or(0.0)));
            continue;
        }
        let Some(st) = super::stems::find_stem(&ink, &g, sp * HEAD_K, f.unit.thick, None, &|x| claims.bar_col(si, x)) else {
            debug(f, sp, si, cx, cy, "无干", "");
            orphans.push(g);
            continue;
        };
        let dx = (st.x - cx) as f64 / sp;
        if !st.up || !(0.0..=0.7).contains(&dx) {
            debug(f, sp, si, cx, cy, "干位", &format!("上{} dx{dx:.2}", st.up as u8));
            continue;
        }
        cands.push((g, st));
    }
    // 同一根干：干的横向差不过两个线宽（至少 0.15 格）、干顶差不过 0.3 格
    cands.sort_by(|a, b| a.0.y.total_cmp(&b.0.y));
    let same = |a: &super::stems::Stem, b: &super::stems::Stem| ((a.x - b.x).abs() as f64) <= (f.unit.thick * 2.0).max(sp * 0.15) && ((a.top - b.top).abs() as f64) <= sp * 0.3;
    let mut used = vec![false; cands.len()];
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for i in 0..cands.len() {
        if used[i] {
            continue;
        }
        let group: Vec<usize> = (i..cands.len()).filter(|&k| !used[k] && same(&cands[i].1, &cands[k].1)).collect();
        group.iter().for_each(|&k| used[k] = true);
        groups.push(group);
    }
    // 连杠的倚音串：两根干横向相距不过 [`RUN_DX`] 格、干顶之间连着杠（逐列在两干顶连线上下 0.15 格内有墨，九成以上的列）
    let beam = |a: &super::stems::Stem, b: &super::stems::Stem| {
        let (l, r) = if a.x < b.x { (a, b) } else { (b, a) };
        let span = r.x - l.x;
        if span < 2 || span as f64 > RUN_DX * sp {
            return false;
        }
        let tol = (sp * 0.15).ceil() as i64;
        let hit = (l.x..=r.x).filter(|&x| {
            let y = l.top + (r.top - l.top) * (x - l.x) / span;
            (y - tol..=y + tol).any(|y| f.ink.at(x, y) == crate::frame::ink::INK)
        }).count();
        hit as f64 >= 0.9 * (span + 1) as f64
    };
    // 杠接到已认出的音符干上的是普通连杠音符（低清图上漏认的头），不是倚音
    let to_main = |st: &super::stems::Stem| row.chords.iter().filter_map(|c| c.stem.as_ref()).any(|cs| cs.up && beam(st, cs));
    let tops: Vec<&super::stems::Stem> = groups.iter().map(|g| &cands[g[0]].1).collect();
    let linked: Vec<bool> = (0..groups.len()).map(|a| (0..groups.len()).any(|b| a != b && beam(tops[a], tops[b]))).collect();
    let mut out: Vec<Grace> = Vec::new();
    let mut runs: Vec<super::stems::Stem> = Vec::new();
    // 串里的倚音（out 下标、干）：最后按杠连通分串定锚点
    let mut members: Vec<(usize, super::stems::Stem)> = Vec::new();
    for (gi, group) in groups.iter().enumerate() {
        let (g, st) = &cands[group[0]];
        let check = if linked[gi] { Check::Run } else if group.len() == 1 { Check::Full } else { Check::Flag };
        if to_main(st) {
            debug(f, sp, si, g.x.round() as i64, g.y.round() as i64, "杠接主音", "");
            continue;
        }
        if !top_ok(f, sp, si, g, st, check) || !row.chords.iter().any(|c| c.x > g.x && c.x - g.x <= REACH * sp) {
            continue;
        }
        let mut ps: Vec<i32> = group.iter().map(|&k| cands[k].0.pos).collect();
        ps.dedup();
        if std::env::var("OMR_GRACE_DEBUG").is_ok() {
            eprintln!("倚音 si{si} x{:.0} y{:.0} 谱位{ps:?}{} 宽{:.2}/{:.2}", g.x, g.y, if linked[gi] { " 连杠" } else { "" }, head_w(f, sp, g.x.round() as i64, g.y.round() as i64), med.unwrap_or(0.0));
        }
        if linked[gi] || group.len() == 1 {
            runs.push(*st);
            members.push((out.len(), *st));
        }
        out.push(Grace { x: g.x, anchor: g.x, pos: ps });
    }
    // 断了干的小头：头右侧 0~0.7 格有一列竖墨，从认出的倚音干顶那么高往下通到头顶上方 0.5 格内（八成五以上的行有墨），
    // 那列顶上与认出的倚音干顶连着杠——是同一串里的；头左边不接笔画、头列竖墨不过一格照样查
    for g in orphans {
        let (cx, cy) = (g.x.round() as i64, g.y.round() as i64);
        let hit = runs.iter().find_map(|st| {
            ((cx..=cx + (sp * 0.7) as i64).find(|&x| {
                let (y0, y1) = (st.top + (sp * 0.2) as i64, cy - (sp * 0.5) as i64);
                y1 - y0 >= (sp * 0.8) as i64 && (y0..=y1).filter(|&y| f.ink.at(x, y) == crate::frame::ink::INK).count() as f64 >= 0.85 * (y1 - y0 + 1) as f64
                    && beam(st, &super::stems::Stem { x, top: st.top, bottom: cy, up: true })
            }))
            .map(|x| super::stems::Stem { x, top: st.top, bottom: cy, up: true })
        });
        let Some(st) = hit else { continue };
        if to_main(&st) {
            continue;
        }
        if !top_ok(f, sp, si, &g, &st, Check::Run) || !row.chords.iter().any(|c| c.x > g.x && c.x - g.x <= REACH * sp) {
            continue;
        }
        if std::env::var("OMR_GRACE_DEBUG").is_ok() {
            eprintln!("倚音 si{si} x{:.0} y{:.0} 谱位[{}] 连杠断干", g.x, g.y, g.pos);
        }
        members.push((out.len(), st));
        out.push(Grace { x: g.x, anchor: g.x, pos: vec![g.pos] });
    }
    // 杠连着的成一串，锚点取串里最右的 x
    let mut comp: Vec<usize> = (0..members.len()).collect();
    for a in 0..members.len() {
        for b in a + 1..members.len() {
            if beam(&members[a].1, &members[b].1) {
                let (ca, cb) = (comp[a], comp[b]);
                comp.iter_mut().filter(|c| **c == cb).for_each(|c| *c = ca);
            }
        }
    }
    for a in 0..members.len() {
        let right = (0..members.len()).filter(|&b| comp[b] == comp[a]).map(|b| out[members[b].0].x).fold(f64::MIN, f64::max);
        out[members[a].0].anchor = right;
    }
    out
}

/// 头心上下各 0.25 格里最宽一行的横向墨宽（相对线距；挂着干的头连干一起量）。
fn head_w(f: &crate::page::PageFrame, sp: f64, cx: i64, cy: i64) -> f64 {
    (cy - (sp * 0.25) as i64..=cy + (sp * 0.25) as i64).map(|y| super::stems::width_at(&f.ink, cx, y, (sp * 1.5) as i64)).max().unwrap_or(0) as f64 / sp
}

/// 本行已认出的实心头宽度（[`head_w`]）的中位数；不到 6 个头不算。
fn row_head_w(f: &crate::page::PageFrame, sp: f64, row: &RowNotes) -> Option<f64> {
    let ws: Vec<f64> = row.chords.iter().flat_map(|c| c.heads.iter()).filter(|h| h.kind == super::heads::HeadKind::Filled).map(|h| head_w(f, sp, h.x.round() as i64, h.y.round() as i64)).collect();
    (ws.len() >= 6).then(|| dolce_omr_core::geom::median(&ws, 0.0))
}

/// 倚音头比本行实心头窄到这个比例以下（比本行实心头宽度的中位数；头缩到 0.65，连干量七成多）。
const SMALL_OF_ROW: f64 = 0.85;

/// 已当成普通和弦认进来的倚音（主识别的种子框撑得满小头时，带斜杠的旗会被数成两道尾）：朝上干、不连杠、有尾、没附点没连音，
/// 各头都是实心、都在干左边（二度挤到右边的除外）、至少三分之二的头比本行实心头窄到 `SMALL_OF_ROW` 以下（碰着邻头、旁边全音符的那个量宽了；低清图上普通和弦里不挨干的头也量得窄，所以两个头的要都窄），最上面的头过 `top_ok`（几个头的只验干长——旗已数过，倚音和弦的头挨着、斜杠穿过；单个头的照样全验），右边 `REACH` 格以内另有主音。
/// 从 `row` 里摘掉，回（中心 x、各头谱位）。
pub fn from_chords(f: &crate::page::PageFrame, si: usize, row: &mut RowNotes) -> Vec<Grace> {
    use super::heads::HeadKind;
    let sp = f.staves[si].space();
    let Some(med) = row_head_w(f, sp, row) else { return Vec::new() };
    if std::env::var("OMR_GRACE_DEBUG").is_ok() {
        for c in &row.chords {
            if let Some(st) = c.stem.as_ref() {
                if c.tails >= 1 && !c.beamed {
                    eprintln!("小和弦? si{si} x{:.0} 上{} 尾{} 点{} 连{} 宽{:?} 中位{med:.2}", c.x, st.up as u8, c.tails, c.dots, c.tuplet.is_some() as u8,
                        c.heads.iter().map(|h| format!("{:?}{:.2}", h.kind, head_w(f, sp, h.x.round() as i64, h.y.round() as i64))).collect::<Vec<_>>());
                }
            }
        }
    }
    let small: Vec<usize> = (0..row.chords.len())
        .filter(|&i| {
            let c = &row.chords[i];
            let Some(st) = c.stem.as_ref() else { return false };
            st.up && !c.beamed && c.tails >= 1 && c.dots == 0 && c.tuplet.is_none() && !c.heads.is_empty()
                && c.heads.iter().all(|h| h.kind == HeadKind::Filled)
                // 朝上干的头都在干左边（二度挤到右边的除外）：糊掉的谱号被认成和弦时「头」散在干两边
                && c.heads.iter().all(|h| (st.x as f64 - h.x) >= 0.15 * sp || c.heads.iter().any(|o| (o.pos - h.pos).abs() == 1))
                && {
                    let w: Vec<f64> = c.heads.iter().map(|h| head_w(f, sp, h.x.round() as i64, h.y.round() as i64)).collect();
                    3 * w.iter().filter(|&&x| x <= SMALL_OF_ROW * med).count() >= 2 * w.len()
                }
                && row.chords.iter().any(|o| o.x > c.x && o.x - c.x <= REACH * sp)
                && top_ok(f, sp, si, c.heads.iter().min_by(|a, b| a.y.total_cmp(&b.y)).unwrap(), st, if c.heads.len() > 1 { Check::StemOnly } else { Check::Full })
        })
        .collect();
    let mut out = Vec::new();
    for &i in small.iter().rev() {
        let c = row.chords.remove(i);
        if std::env::var("OMR_GRACE_DEBUG").is_ok() {
            eprintln!("倚音和弦 si{si} x{:.0} 谱位{:?} 中位头宽{med:.2} 头x{:?} 干x{:?}", c.x, c.heads.iter().map(|h| h.pos).collect::<Vec<_>>(), c.heads.iter().map(|h| ((h.x - c.x) / sp * 100.0).round() / 100.0).collect::<Vec<_>>(), c.stem.map(|s| ((s.x as f64 - c.x) / sp * 100.0).round() / 100.0));
        }
        out.push(Grace { x: c.x, anchor: c.x, pos: c.heads.iter().map(|h| h.pos).collect() });
    }
    out
}

/// [`top_ok`] 查到哪一步。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Check {
    /// 干长、头周围、干顶的旗。
    Full,
    /// 干长与旗（一根干上几个头：头上下挨着）。
    Flag,
    /// 只查干长（主识别已认成带尾的和弦）。
    StemOnly,
    /// 连杠的倚音串里的一个：干长、头列竖墨、头左边接笔画；不查干左上方（前一个的杠、串上的圆滑线）与旗（杠就是证据）。
    Run,
}

/// 倚音干上最上面那个头的结构检查：干长（头心到干顶）在 [`STEM_LEN`] 内；
/// [`Check::Full`]（干上只这一个头）时另查：干左边头上方是空的、头那几列竖墨不过一格（排除升号、还原号、谱号、休止符），头左边不接着笔画（圆滑线、力度字母、括号）；
/// 干顶旁有细横墨（旗、或几个倚音连着的杠；竖着厚过 0.55 格的是朝下干的正常符头）。斜杠穿干、旗朝哪边都不看。
fn top_ok(f: &crate::page::PageFrame, sp: f64, si: usize, g: &super::heads::Head, st: &super::stems::Stem, check: Check) -> bool {
    use crate::frame::ink::INK;
    let (cx, cy) = (g.x.round() as i64, g.y.round() as i64);
    let len = (cy - st.top) as f64 / sp;
    let dbg = |why: &str| debug(f, sp, si, cx, cy, why.split(' ').next().unwrap_or(""), &format!("{why} 干{len:.2}"));
    if !(STEM_LEN.0..=STEM_LEN.1).contains(&len) {
        dbg("干长");
        return false;
    }
    let frac = |x0: i64, x1: i64, y0: i64, y1: i64| (y0..=y1).flat_map(|y| (x0..=x1).map(move |x| (x, y))).filter(|&(x, y)| f.ink.at(x, y) == INK).count() as f64 / ((x1 - x0 + 1).max(1) * (y1 - y0 + 1).max(1)) as f64;
    // 头周围是空的（单个倚音才查；倚音和弦的头上下挨着、斜杠斜穿左上）
    let head_clear = || {
        // 升号、还原号：干左边、头上方有墨（升号的左竖；倚音的旗在干右边）；
        // 谱号、休止符：头那几列（干左边）竖着连的墨超过一格（倚音头不到 0.7 格，底下跨过的圆滑线不连着头）
        let vrun = |x: i64| {
            if f.ink.at(x, cy) != INK {
                return 0;
            }
            let (mut a, mut b) = (cy, cy);
            while cy - a < (sp * 3.0) as i64 && f.ink.at(x, a - 1) == INK {
                a -= 1;
            }
            while b - cy < (sp * 3.0) as i64 && f.ink.at(x, b + 1) == INK {
                b += 1;
            }
            b - a + 1
        };
        let tall = (cx - (sp * 0.2) as i64..=(cx + (sp * 0.2) as i64).min(st.x - (sp * 0.12) as i64)).map(vrun).max().unwrap_or(0) as f64 / sp;
        let above = frac(cx - (sp * 0.4) as i64, st.x - (sp * 0.12) as i64, cy - (sp * 1.4) as i64, cy - (sp * 0.5) as i64);
        if tall > 1.0 || (above > 0.08 && check != Check::Run) {
            dbg(&format!("头旁 竖{tall:.2} 左上{above:.2}"));
            return false;
        }
        // 头左边接着笔画（圆滑线粗的一段、力度字母 f 的圈、括号）：头正左 0.45~0.65 格墨过一成五，或左上墨过三成、左下墨过六成
        // （倚音左边是空的；底下跨过去的圆滑线在左下顶多四成）
        let rel = |x0: f64, x1: f64, y0: f64, y1: f64| frac(cx + (sp * x0) as i64, cx + (sp * x1) as i64, cy + (sp * y0) as i64, cy + (sp * y1) as i64);
        let (l, lu, ld) = (rel(-0.65, -0.45, -0.25, 0.25), rel(-0.65, -0.3, -0.6, -0.3), rel(-0.65, -0.3, 0.3, 0.6));
        if l > 0.15 || lu > 0.3 || ld > 0.6 {
            dbg(&format!("左接 {l:.2}/{lu:.2}/{ld:.2}"));
            return false;
        }
        true
    };
    if matches!(check, Check::Full | Check::Run) && !head_clear() {
        return false;
    }
    if matches!(check, Check::StemOnly | Check::Run) {
        debug(f, sp, si, cx, cy, "ok", "");
        return true;
    }
    // 干顶旁的横墨：干顶往下 0.8 格内，干左或干右 0.25~0.75 格处有墨的行至少两行；那几列竖着连的墨都不过 0.55 格
    let cols = |dir: i64| ((sp * 0.25) as i64..=(sp * 0.75) as i64).map(move |d| st.x + dir * d);
    let rows = st.top - (sp * 0.2) as i64..st.top + (sp * 0.8) as i64;
    let side = |dir: i64| rows.clone().filter(|&y| cols(dir).any(|x| f.ink.at(x, y) == INK)).count() >= 2;
    let fat = |dir: i64| {
        cols(dir).any(|x| {
            let (mut run, mut best) = (0i64, 0i64);
            for y in st.top - (sp * 0.6) as i64..st.top + (sp * 1.2) as i64 {
                run = if f.ink.at(x, y) == INK { run + 1 } else { 0 };
                best = best.max(run);
            }
            best as f64 > 0.55 * sp
        })
    };
    if (!side(1) && !side(-1)) || fat(1) || fat(-1) {
        dbg(&format!("干顶 旁{}{} 厚{}{}", side(-1) as u8, side(1) as u8, fat(-1) as u8, fat(1) as u8));
        return false;
    }
    debug(f, sp, si, cx, cy, "ok", "");
    true
}

/// 排查：`OMR_GRACE_DEBUG` 设了就打出拒绝原因；给的是目录时另把候选周围三格写成 PGM（中心打灰十字，文件名带原因）。
fn debug(f: &crate::page::PageFrame, sp: f64, si: usize, cx: i64, cy: i64, tag: &str, msg: &str) {
    if std::env::var("OMR_GRACE_DEBUG").is_err() {
        return;
    }
    if tag != "ok" {
        eprintln!("拒 {tag} si{si} x{cx} y{cy} {msg}");
    }
    dump(f, sp, si, cx, cy, tag);
}

fn dump(f: &crate::page::PageFrame, sp: f64, _si: usize, cx: i64, cy: i64, tag: &str) {
    use crate::frame::ink::INK;
    let Ok(dir) = std::env::var("OMR_GRACE_DEBUG") else { return };
    if dir.is_empty() {
        return;
    }
    let r = (sp * 3.0) as i64;
    let (x0, y0, n) = (cx - r, cy - r, 2 * r + 1);
    let mut pgm = format!("P5\n{n} {n}\n255\n").into_bytes();
    for y in y0..y0 + n {
        for x in x0..x0 + n {
            pgm.push(if (x == cx || y == cy) && (x - cx).abs() + (y - cy).abs() < 4 { 128 } else if f.ink.at(x, y) == INK { 0 } else { 255 });
        }
    }
    let _ = std::fs::write(format!("{dir}/g-y{cy:05}-x{cx:04}-{tag}.pgm"), pgm);
}
