//! 倚音：小号符头挂到右边紧跟的主音上（位图、矢量两路共用）。混排页另从简谱行接（`mixed::fuse::attach_graces`）。

use super::RowNotes;

/// 倚音往右找主音最多找这么远（相对线距）。
pub const REACH: f64 = 4.0;

/// 小号符头（中心 x、谱位）各挂到右边 [`REACH`] 格以内最近的和弦，按 x 自左而右记进 `Chord::graces`。
pub fn attach(row: &mut RowNotes, sp: f64, heads: &[(f64, i32)]) -> usize {
    let mut hs = heads.to_vec();
    hs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut n = 0;
    for (x, pos) in hs {
        let Some(ci) = (0..row.chords.len()).filter(|&i| row.chords[i].x > x && row.chords[i].x - x <= sp * REACH).min_by(|&a, &b| row.chords[a].x.total_cmp(&row.chords[b].x)) else { continue };
        row.chords[ci].graces.push(pos);
        n += 1;
    }
    n
}

/// 倚音符头相对本页符头的大小（种子框、找干的尺子都乘它）。
const HEAD_K: f64 = 0.65;
/// 倚音的干长（头心到干顶，相对线距）范围。
const STEM_LEN: (f64, f64) = (1.6, 3.2);
/// 倚音头宽范围（相对线距，头心上下各 0.25 格里最宽的一行）：正常的头一格多宽，只有干那么细的不是头。
const HEAD_W: (f64, f64) = (0.45, 0.95);
/// 已认出的符头横向这么近（相对线距）、音级差不过 2 的种子是那个头自己的墨。
const NEAR_HEAD: f64 = 0.9;

/// 位图页一行谱的倚音符头（中心 x、谱位）：按本页符头缩小的种子框撑得满（[`super::heads::seeds_scaled`]），
/// 不是已认出的头、不在休止符上，头宽在 [`HEAD_W`] 内；挂得上朝上的干（干长 [`STEM_LEN`]、在头右侧）；
/// 干左边头上方是空的、头那几列竖墨不过一格（排除升号、还原号、谱号、休止符）；头左边不接着笔画（圆滑线、力度字母、括号）；
/// 干顶旁有细横墨（旗、或几个倚音连着的杠；竖着厚过 0.55 格的是朝下干的正常符头）；右边 [`REACH`] 格以内有主音。
/// 斜杠穿干、旗朝哪边都不看。排查用 `OMR_GRACE_DEBUG`（给目录时写出候选局部图）。
pub fn raster(f: &crate::page::PageFrame, solid: &crate::frame::ink::InkLayers, sum: &super::heads::InkSum, claims: &super::resolve::Claims, si: usize, x_from: f64, row: &RowNotes) -> Vec<(f64, i32)> {
    use crate::frame::ink::INK;
    let sp = f.staves[si].space();
    let ink = f.stem_ink();
    let seeds: Vec<super::heads::Head> = super::heads::seeds_scaled(f, solid, sum, si, x_from, HEAD_K)
        .into_iter()
        .filter(|g| !row.chords.iter().any(|c| c.heads.iter().any(|h| (h.x - g.x).abs() < NEAR_HEAD * sp && (h.pos - g.pos).abs() <= 2)))
        .filter(|g| !row.rests.iter().any(|r| g.x >= r.rect.0 - sp * 0.2 && g.x <= r.rect.0 + r.rect.2 + sp * 0.2))
        .collect();
    let mut out: Vec<(f64, i32)> = Vec::new();
    for g in super::heads::fullest(seeds, sp * HEAD_K) {
        let (cx, cy) = (g.x.round() as i64, g.y.round() as i64);
        let dbg0 = |why: &str| {
            if std::env::var("OMR_GRACE_DEBUG").is_ok() {
                eprintln!("拒 {why} si{si} x{cx} y{cy}");
                dump(f, sp, si, cx, cy, why);
            }
        };
        let hw = (cy - (sp * 0.25) as i64..=cy + (sp * 0.25) as i64).map(|y| super::stems::width_at(&f.ink, cx, y, (sp * 1.5) as i64)).max().unwrap_or(0) as f64 / sp;
        if !(HEAD_W.0..=HEAD_W.1).contains(&hw) {
            dbg0("宽");
            continue;
        }
        let Some(st) = super::stems::find_stem(&ink, &g, sp * HEAD_K, f.unit.thick, None, &|x| claims.bar_col(si, x)) else {
            dbg0("无干");
            continue;
        };
        let len = (cy - st.top) as f64 / sp;
        if !st.up || len < STEM_LEN.0 || len > STEM_LEN.1 {
            dbg0(&format!("干长{}{len:.1}", if st.up { "上" } else { "下" }));
            continue;
        }
        // 干挂在头右侧
        let dx = (st.x - cx) as f64 / sp;
        let dbg = |why: &str| {
            if std::env::var("OMR_GRACE_DEBUG").is_ok() {
                eprintln!("拒 {why} si{si} x{cx} y{cy} 干{len:.2} dx{dx:.2}");
                dump(f, sp, si, cx, cy, why.split(' ').next().unwrap_or(""));
            }
        };
        if !(0.0..=0.7).contains(&dx) {
            dbg("干位");
            continue;
        }
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
        let (ax0, ax1, ay0, ay1) = (cx - (sp * 0.4) as i64, st.x - (sp * 0.12) as i64, cy - (sp * 1.4) as i64, cy - (sp * 0.5) as i64);
        let above = (ay0..=ay1).flat_map(|y| (ax0..=ax1).map(move |x| (x, y))).filter(|&(x, y)| f.ink.at(x, y) == INK).count() as f64 / (((ax1 - ax0 + 1).max(1) * (ay1 - ay0 + 1)) as f64);
        if tall > 1.0 || above > 0.08 {
            dbg(&format!("头旁 竖{tall:.2} 左上{above:.2}"));
            continue;
        }
        // 头左边接着笔画（圆滑线粗的一段、力度字母 f 的圈、括号）：头正左 0.45~0.65 格墨过一成五，或左上墨过三成、左下墨过六成
        // （倚音左边是空的；底下跨过去的圆滑线在左下顶多四成）
        let frac = |x0: f64, x1: f64, y0: f64, y1: f64| {
            let (xa, xb, ya, yb) = (cx + (sp * x0) as i64, cx + (sp * x1) as i64, cy + (sp * y0) as i64, cy + (sp * y1) as i64);
            (ya..=yb).flat_map(|y| (xa..=xb).map(move |x| (x, y))).filter(|&(x, y)| f.ink.at(x, y) == INK).count() as f64 / ((xb - xa + 1) * (yb - ya + 1)) as f64
        };
        let (l, lu, ld) = (frac(-0.65, -0.45, -0.25, 0.25), frac(-0.65, -0.3, -0.6, -0.3), frac(-0.65, -0.3, 0.3, 0.6));
        if l > 0.15 || lu > 0.3 || ld > 0.6 {
            dbg(&format!("左接 {l:.2}/{lu:.2}/{ld:.2}"));
            continue;
        }
        // 干顶旁的横墨：干顶往下 0.8 格内，干左或干右 0.25~0.75 格处有墨的行至少两行；
        // 那几列竖着连的墨都不过 0.55 格（旗、倚音的细杠；朝下干的正常符头在干顶，竖着一格左右厚）
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
            continue;
        }
        if !row.chords.iter().any(|c| c.x > g.x && c.x - g.x <= REACH * sp) {
            continue;
        }
        dump(f, sp, si, cx, cy, "ok");
        if std::env::var("OMR_GRACE_DEBUG").is_ok() {
            eprintln!("倚音 si{si} x{cx} y{cy} pos{} 干{len:.2} 宽{hw:.2} 左接{l:.2}/{lu:.2}/{ld:.2}", g.pos);
        }
        out.push((g.x, g.pos));
    }
    out
}

/// 排查：`OMR_GRACE_DEBUG=<目录>` 时把候选周围三格写成 PGM（中心打灰十字）。
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
