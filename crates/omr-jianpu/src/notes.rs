//! JM3 音符数据：带内各格 → 音。数字读数（rec）、增时线、附点在带内；八度点在数字正上 / 正下的小圆块；
//! 减时线是带下方的细长横墨（按横向游程找，不靠连通块：线与数字、低音点粘着也照样量得出）。
use crate::frame::{digit_cell, digit_of, Cell, CellKind, RowFrame};
use crate::prep::{Comp, Ink};
use crate::result::{Alt, AltKind, JpNum};
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::cache::CachedOcr;

/// 一行谱的音符层产物。
#[derive(Clone, Debug, Default)]
pub struct RowNotes {
    pub nums: Vec<JpNum>,
    pub barline_xs: Vec<f64>,
    pub double_bar_xs: Vec<f64>,
    /// 行末是细 + 粗的终止线
    pub final_end: bool,
    /// 行中的终止线（右边那根的 x）
    pub end_bar_xs: Vec<f64>,
    /// 已归了音符的墨（减时线、低音点），歌词切行时不算字
    pub claimed: Vec<Rect>,
}

/// 细长横墨：列范围与行范围（都含端点）。
#[derive(Clone, Copy, Debug)]
pub struct HLine {
    pub x0: i64,
    pub x1: i64,
    pub y0: i64,
    pub y1: i64,
}

/// 框里的细长横墨：每行取不短于 `min_len` 的横向墨段（容一像素断口），上下相邻、横向大半重叠的并成一条。
pub fn hlines(ink: &Ink, xa: i64, xb: i64, ya: i64, yb: i64, min_len: i64) -> Vec<HLine> {
    let mut done: Vec<HLine> = Vec::new();
    let mut open: Vec<HLine> = Vec::new();
    for y in ya..yb {
        let mut runs: Vec<(i64, i64)> = Vec::new();
        let mut x = xa;
        while x < xb {
            if !ink.at(x, y) {
                x += 1;
                continue;
            }
            let a = x;
            while x < xb && (ink.at(x, y) || (ink.at(x + 1, y) && x + 1 < xb)) {
                x += 1;
            }
            if x - a >= min_len {
                runs.push((a, x - 1));
            }
        }
        let mut next: Vec<HLine> = Vec::new();
        for (a, b) in runs {
            let hit = open.iter().position(|s| {
                let ov = b.min(s.x1) - a.max(s.x0) + 1;
                ov as f64 >= 0.6 * ((b - a + 1).min(s.x1 - s.x0 + 1)) as f64
            });
            match hit {
                Some(i) => {
                    let s = open.remove(i);
                    next.push(HLine { x0: s.x0.min(a), x1: s.x1.max(b), y0: s.y0, y1: y });
                }
                None => next.push(HLine { x0: a, x1: b, y0: y, y1: y }),
            }
        }
        done.append(&mut open);
        open = next;
    }
    done.append(&mut open);
    done
}

/// 读成「1」的格像不像一根光竖条：窄，各行墨宽几乎一样（「1」顶上有旗、多半还有底座，那几行宽出去）。
fn bar_like(ink: &Ink, c: &Cell, h: f64) -> bool {
    if c.w() > h * 0.3 {
        return false;
    }
    let ws: Vec<f64> = (c.y0..=c.y1).map(|y| (c.x0..=c.x1).filter(|&x| ink.at(x, y)).count() as f64).collect();
    let med = dolce_omr_core::geom::median(&ws, 1.0);
    let wide = ws.iter().filter(|&&w| w > med * 1.5 + 1.0).count();
    (wide as f64) < ws.len() as f64 * 0.08
}

/// 线的两头是不是都顺着往下弯（弧的平顶：下面那行谱的连线拱到这一行脚下）。减时线两头是齐的。
fn arc_ends(ink: &Ink, x0: i64, x1: i64, y1: i64) -> bool {
    let down = |x: i64, dir: i64| (1..=3).any(|d| (1..=3).any(|e| ink.at(x + dir * d, y1 + e)));
    down(x0, -1) && down(x1, 1)
}

/// 行首印的段落名（「前奏」「前奏：」，同 TS `prelude.rowHead` / `pseudoRow.headWithPrelude`）：行首连着的数字格按贴着的并成块，
/// 近方（宽不下于 0.85 高）、不比本行数字矮的块是字（数字是竖长的）；两块以上，或一块却比数字高出一成半，其后还有三个以上的数字格、
/// 其中七成不是近方的，且块前没有小节线。整块送去读，读出一到四个汉字才算。回（摘掉的格数, 字）。
fn head_label(ink: &Ink, row: &RowFrame, ocr: &CachedOcr) -> Option<(usize, String)> {
    let cells = &row.cells;
    let first = cells.iter().position(|c| c.kind == CellKind::Digit)?;
    if cells[..first].iter().any(|c| matches!(c.kind, CellKind::Bar { .. })) {
        return None;
    }
    let hs: Vec<f64> = cells.iter().filter(|c| c.kind == CellKind::Digit).map(|c| c.h()).collect();
    let med_h = dolce_omr_core::geom::median(&hs, row.h());
    // 从首个数字格起，贴着（隔不过 2 像素）的格并成块
    let mut blocks: Vec<(usize, usize, Rect)> = Vec::new();
    let mut i = first;
    while i < cells.len() && cells[i].kind == CellKind::Digit {
        let mut j = i;
        let mut r = cells[i].rect();
        while j + 1 < cells.len() && cells[j + 1].kind == CellKind::Digit && cells[j + 1].x0 - cells[j].x1 <= 2 {
            j += 1;
            r = r.union(&cells[j].rect());
        }
        blocks.push((i, j, r));
        i = j + 1;
    }
    let square = |r: &Rect| r.w >= r.h * 0.85 && r.h >= med_h * 0.95;
    let k = blocks.iter().take_while(|b| square(&b.2)).count();
    if k == 0 || k >= blocks.len() {
        return None;
    }
    let tall = blocks[..k].iter().any(|b| b.2.h >= med_h * 1.15);
    let rest = &blocks[k..];
    if (k < 2 && !tall) || rest.len() < 3 || (rest.iter().filter(|b| !square(&b.2)).count() as f64) < rest.len() as f64 * 0.7 {
        return None;
    }
    let mut r = blocks[0].2;
    for b in &blocks[1..k] {
        r = r.union(&b.2);
    }
    let pad = med_h * 0.3;
    let roi = Rect::new((r.x - pad).max(0.0), (r.y - pad).max(0.0), r.w + pad * 2.0, r.h + pad * 2.0);
    let text: String = ocr.read_line(&ink.crop_bin(&roi)).ok()?.into_iter().map(|c| c.ch).collect::<String>().split_whitespace().collect();
    let n = text.chars().count();
    if !(1..=4).contains(&n) || !text.chars().all(dolce_omr_text::chars::is_han) {
        return None;
    }
    Some((blocks[k - 1].1 + 1, text))
}

/// 横墨是一块字形的顶横（下一行数字「5」「7」的顶、「2」「3」的顶弧）：它所在的连通块顶不比这道横高出半个字号（逐列量时侧边列的顶比弧顶低）、往下伸出 0.4 字号以上。
/// 减时线自成一块，或粘着上面的数字（块往上伸）。
fn glyph_top(ink: &Ink, x0: i64, x1: i64, y0: i64, y1: i64, h: f64) -> bool {
    ink.comps().iter().any(|k| {
        let r = &k.rect;
        r.x <= x0 as f64 + 1.0 && r.right() >= x1 as f64 && r.y >= y0 as f64 - h * 0.5 && r.y <= y0 as f64 + 1.0 && r.bottom() >= y1 as f64 + h * 0.4
    })
}

/// 八度点 / 附点样的小圆块。
pub fn dot_like(k: &Comp, h: f64) -> bool {
    let (w, hh) = (k.rect.w, k.rect.h);
    w >= h * 0.08 && hh >= h * 0.08 && w <= h * 0.42 && hh <= h * 0.42 && w / hh > 0.55 && w / hh < 1.8 && k.fill() >= 0.55
}

pub fn build(ink: &Ink, row: &RowFrame, ocr: &CachedOcr, ctx: crate::marks::RowCtx) -> RowNotes {
    let h = row.h();
    let mut out = RowNotes::default();
    // 行首印的段落名（「前奏」）：摘掉那几格，认出字的挂到首音上
    let (skip, head_mark) = head_label(ink, row, ocr).map_or((0, None), |(k, t)| (k, Some(t)));
    let cells: Vec<&Cell> = row.cells.iter().skip(skip).collect();
    // 读数
    let digit_cells: Vec<&Cell> = cells.iter().copied().filter(|c| c.kind == CellKind::Digit).collect();
    let imgs: Vec<_> = digit_cells.iter().map(|c| digit_cell(ink, &c.rect())).collect();
    let texts = ocr.read_cells(&imgs).unwrap_or_else(|_| vec![String::new(); imgs.len()]);
    let mut read: Vec<Option<u8>> = Vec::with_capacity(texts.len());
    for (i, t) in texts.iter().enumerate() {
        let mut d = digit_of(t);
        if d.is_none() && !t.trim().is_empty() {
            d = crate::frame::alt_digit(ocr, &imgs[i]);
        }
        read.push(d);
    }
    // 按 x 走一遍各格：数字起一个音，增时线、附点记到前一个音上，小节线与冒号记结构
    let mut di = 0;
    let mut pending_forward = false;
    let mut bars: Vec<&Cell> = Vec::new();
    let mut last_bar_x1: Option<i64> = None;
    for &c in &cells {
        match c.kind {
            CellKind::Digit => {
                let d = read[di];
                di += 1;
                let Some(d) = d else { continue };
                let mut n = JpNum { digit: d, bbox: c.rect(), bar_like: d == 1 && bar_like(ink, c, h), ..Default::default() };
                n.repeat_forward = std::mem::take(&mut pending_forward);
                out.nums.push(n);
            }
            CellKind::Dash => {
                if let Some(n) = out.nums.last_mut() {
                    n.augment += 1;
                    n.augment_rects.push(c.rect());
                    // 短得勉强的横（不到 0.4 字号）：也许是杂墨
                    if c.w() < h * 0.4 {
                        n.alts.push(Alt { kind: AltKind::AugMinus, cost: 1.2 });
                    }
                }
            }
            CellKind::Dot => {
                if let Some(n) = out.nums.last_mut() {
                    let after_bar = last_bar_x1.is_some_and(|b| b as f64 > n.bbox.right());
                    let gap = c.x0 as f64 - n.bbox.right();
                    if n.augment == 0 && !after_bar && gap <= h * 2.0 && gap >= -1.0 {
                        n.dot += 1;
                        // 离数字一个字号开外的点：收得勉强
                        if gap > h {
                            n.alts.push(Alt { kind: AltKind::DotMinus, cost: 1.0 });
                        }
                    } else if n.augment == 0 && !after_bar && gap > h * 2.0 && gap <= h * 3.0 {
                        n.alts.push(Alt { kind: AltKind::DotPlus, cost: 1.2 });
                    }
                }
            }
            CellKind::Bar { .. } => {
                bars.push(c);
                last_bar_x1 = Some(c.x1);
                out.barline_xs.push(c.cx());
            }
            CellKind::Colon => {
                // 冒号贴着小节线：在线左是反复结束，在线右是反复开始
                match last_bar_x1 {
                    Some(b) if (c.x0 - b) as f64 <= h * 0.6 => pending_forward = true,
                    _ => {
                        if let Some(n) = out.nums.last_mut() {
                            n.repeat_backward = true;
                        }
                    }
                }
            }
            CellKind::Other => {
                // 没归上类的小墨：像点的（偏高、偏大一点）、像横的（短一点、扁得不够）各记一个候选
                let Some(n) = out.nums.last_mut() else { continue };
                let after_bar = last_bar_x1.is_some_and(|b| b as f64 > n.bbox.right());
                let gap = c.x0 as f64 - n.bbox.right();
                if after_bar || gap < -1.0 {
                    continue;
                }
                let (cw, ch) = (c.w(), c.h());
                if cw <= h * 0.5 && ch <= h * 0.5 && cw >= h * 0.08 && ch >= h * 0.08 && n.augment == 0 && n.dot == 0 && gap <= h * 1.2 {
                    n.alts.push(Alt { kind: AltKind::DotPlus, cost: 1.2 });
                } else if ch <= h * 0.35 && cw >= h * 0.2 && cw >= ch * 1.3 && c.y0 as f64 >= row.top_at(c.cx()) + h * 0.15 && (c.y1 as f64) <= row.bottom_at(c.cx()) - h * 0.1 {
                    n.alts.push(Alt { kind: AltKind::AugPlus, cost: 1.2 });
                }
            }
        }
    }
    // 并排两根：复纵线；右边那根粗的是终止线（行末的记 final_end）
    let last_num_right = out.nums.last().map_or(f64::MIN, |n| n.bbox.right());
    for w in bars.windows(2) {
        let (a, b) = (w[0], w[1]);
        if (b.x0 - a.x1) as f64 > h * 0.35 {
            continue;
        }
        // 声部行（连谱号括着）粗细按两根彼此比：同一道 ‖ 的细粗之比比对全行中位稳（四声部 5px + 9px、4px + 7px）
        let thick = matches!(b.kind, CellKind::Bar { thick: true }) || (ctx == crate::marks::RowCtx::InSystem && b.w() >= a.w() * 1.3);
        let at_end = b.cx() > last_num_right && std::ptr::eq(b, *bars.last().unwrap());
        let repeat = out.nums.iter().any(|n| n.repeat_backward && n.bbox.right() < a.cx() && a.cx() - n.bbox.right() < h * 3.0)
            || out.nums.iter().any(|n| n.repeat_forward && n.bbox.x > b.cx() && n.bbox.x - b.cx() < h * 3.0);
        if repeat {
            continue;
        }
        if thick && at_end {
            out.final_end = true;
        } else if thick {
            out.end_bar_xs.push(b.cx());
        } else {
            out.double_bar_xs.push(b.cx());
        }
    }
    if let (Some(t), Some(n)) = (head_mark, out.nums.first_mut()) {
        n.section_mark = Some(t);
    }
    underlines(ink, row, &mut out);
    let used = crate::marks::apply(ink, row, &mut out, ocr, ctx);
    octave_dots(ink, row, &mut out, &used);
    out
}

/// 减时线：数字正下方一道道细横线。第一道离数字底不过 0.4 字号，其后每道与上一道之间的空白不过 0.25 字号、不比上一道宽出去。
/// 间隔按**空白行数**量（小图上一道线一像素厚、隔两像素，按坐标差算就过了门）。差一点没收的、收得勉强的记候选，交满拍裁决。
fn underlines(ink: &Ink, row: &RowFrame, out: &mut RowNotes) {
    let h = row.h();
    let w = ink.w() as f64;
    let ya = row.bottom_at(0.0).min(row.bottom_at(w)).floor() as i64;
    let yb = row.bottom_at(0.0).max(row.bottom_at(w)).ceil() as i64 + (h * 1.0) as i64;
    let max_thick = (h * 0.2).max(4.0);
    // 厚过一道线上限、不到两倍的也留着：多半是两道线印粘了（按一道收，另记「多一道」的候选）
    let lines: Vec<HLine> = hlines(ink, 0, ink.w() as i64, ya, yb, (h * 0.4) as i64).into_iter().filter(|l| ((l.y1 - l.y0 + 1) as f64) <= max_thick * 2.0 && !arc_ends(ink, l.x0, l.x1, l.y1) && !glyph_top(ink, l.x0, l.x1, l.y0, l.y1, h)).collect();
    let thick = |l: &HLine| (l.y1 - l.y0 + 1) as f64;
    let slack = h * 0.15;
    let mut used: Vec<usize> = Vec::new();
    // 各音收下的线（下标）
    let mut taken: Vec<Vec<usize>> = Vec::with_capacity(out.nums.len());
    for n in &mut out.nums {
        let cx = n.bbox.cx();
        let bottom = row.bottom_at(cx).max(n.bbox.bottom());
        let mut under: Vec<usize> = (0..lines.len())
            .filter(|&i| {
                let l = &lines[i];
                l.x0 as f64 - slack <= cx && cx <= l.x1 as f64 + slack && l.y0 as f64 >= bottom - h * 0.02
            })
            .collect();
        under.sort_by_key(|&i| lines[i].y0);
        let mut prev: Option<&HLine> = None;
        let mut mine: Vec<usize> = Vec::new();
        for i in under {
            let l = &lines[i];
            // 与上一道（或数字底）之间的空白
            let blank = match prev {
                None => l.y0 as f64 - bottom,
                Some(p) => (l.y0 - p.y1 - 1) as f64,
            };
            let lim = if prev.is_none() { h * 0.4 } else { h * 0.25 };
            let fits = prev.is_none_or(|p| l.y0 > p.y1 && l.x0 as f64 >= p.x0 as f64 - slack && l.x1 as f64 <= p.x1 as f64 + slack);
            // 数字格切短了时它自己的底横（「2」）贴着格底、横向不出数字框
            if prev.is_none() && blank < 1.0 && l.x0 as f64 >= n.bbox.x - 2.0 && l.x1 as f64 <= n.bbox.right() + 2.0 && ink.at(((l.x0 + l.x1) / 2) as i64, l.y0 - 1) {
                break;
            }
            if blank > lim || !fits {
                // 差一点：隔得稍远（不到门的 1.8 倍），或隔得不远却宽出去了
                if fits && blank <= lim * 1.8 {
                    n.alts.push(Alt { kind: AltKind::DivPlus, cost: 1.0 });
                } else if !fits && blank <= lim && prev.is_some_and(|p| l.y0 > p.y1) {
                    n.alts.push(Alt { kind: AltKind::DivPlus, cost: 1.5 });
                }
                break;
            }
            // 收得勉强：贴着门、或线比数字窄得多
            if blank > lim * 0.75 || ((l.x1 - l.x0 + 1) as f64) < n.bbox.w * 0.5 {
                n.alts.push(Alt { kind: AltKind::DivMinus, cost: 1.2 });
            }
            n.div += 1;
            prev = Some(l);
            mine.push(i);
            if !used.contains(&i) {
                used.push(i);
            }
            if n.div >= 4 {
                break;
            }
        }
        // 没罩到数字中线、却压着数字小半边的线（线印短了或数字偏了）：位置合下一道线的也记候选
        let floor = prev.map_or(bottom, |p| p.y1 as f64 + 1.0);
        let lim = if prev.is_none() { h * 0.4 } else { h * 0.25 };
        let half = (0..lines.len()).any(|i| {
            let l = &lines[i];
            let ov = (l.x1 as f64 + 1.0).min(n.bbox.right()) - (l.x0 as f64).max(n.bbox.x);
            !mine.contains(&i) && !(l.x0 as f64 - slack <= cx && cx <= l.x1 as f64 + slack) && ov >= n.bbox.w * 0.3 && l.y0 as f64 >= floor - h * 0.02 && l.y0 as f64 - floor <= lim
        });
        if half && n.div < 4 {
            n.alts.push(Alt { kind: AltKind::DivPlus, cost: 1.3 });
        }
        if std::env::var("OMR_DIV_DEBUG").is_ok() && !mine.is_empty() {
            eprintln!("减时线 音{} @{:.0},{:.0}：{:?}", n.digit, n.bbox.x, n.bbox.y, mine.iter().map(|&i| (lines[i].x0, lines[i].x1, lines[i].y0, lines[i].y1)).collect::<Vec<_>>());
        }
        taken.push(mine);
    }
    // 逐列再数一遍：两道线一头印粘了（斜着碰上）时按整条线量是一道，数字正下方的各列里却分得开
    let min_len = (h * 0.4) as i64;
    for n in out.nums.iter_mut() {
        let bottom = row.bottom_at(n.bbox.cx()).max(n.bbox.bottom());
        let (xa, xb) = ((n.bbox.x + n.bbox.w * 0.25).round() as i64, (n.bbox.right() - n.bbox.w * 0.25).round() as i64);
        let mut counts: Vec<u32> = Vec::new();
        let mut rects: Vec<Vec<Rect>> = Vec::new();
        for x in xa..=xb.max(xa) {
            let mut cnt = 0;
            let mut rs: Vec<Rect> = Vec::new();
            let mut floor = bottom;
            let mut prev: Option<(i64, i64)> = None;
            let mut y = (bottom - h * 0.02).ceil() as i64;
            while cnt < 4 {
                // 下一截墨
                while (y as f64) < floor + h * 0.4 + 1.0 && !ink.at(x, y) {
                    y += 1;
                }
                if !ink.at(x, y) {
                    break;
                }
                let y0 = y;
                let (mut rx0, mut rx1) = (i64::MAX, i64::MIN);
                while ink.at(x, y) && ((y - y0) as f64) < max_thick {
                    // 这一行穿过本列的横向墨段（容一像素断口），各行取最宽
                    let (mut a, mut b) = (x, x);
                    while a > 0 && (ink.at(a - 1, y) || ink.at(a - 2, y)) {
                        a -= 1;
                    }
                    while b < ink.w() as i64 && (ink.at(b + 1, y) || ink.at(b + 2, y)) {
                        b += 1;
                    }
                    rx0 = rx0.min(a);
                    rx1 = rx1.max(b);
                    y += 1;
                }
                let blank = y0 as f64 - floor;
                let lim = if cnt == 0 { h * 0.4 } else { h * 0.25 };
                // 歌词字的顶横两头都宽出去半个字号以上；线头印得参差的不算
                let fits = prev.is_none_or(|p| rx0 as f64 >= p.0 as f64 - h * 0.5 || rx1 as f64 <= p.1 as f64 + h * 0.5);
                // 贴着数字的头一道得比数字宽出八成：数字格切短了一两行时，数字自己的底弧（「6」「3」）就落在这里
                // 贴着数字、横向又不出数字框的是数字自己的底（「2」的底横、「6」「3」的底弧）
                let stub = cnt == 0 && blank < 1.0 && (((rx1 - rx0 + 1) as f64) < n.bbox.w * 0.8 || (rx0 as f64 >= n.bbox.x - 2.0 && rx1 as f64 <= n.bbox.right() + 2.0));
                if ink.at(x, y) || stub || rx1 - rx0 + 1 < min_len || blank > lim || !fits || arc_ends(ink, rx0, rx1, y - 1) || glyph_top(ink, rx0, rx1, y0, y - 1, h) {
                    break;
                }
                cnt += 1;
                rs.push(Rect::new(rx0 as f64, y0 as f64, (rx1 - rx0 + 1) as f64, (y - y0) as f64));
                prev = Some((rx0, rx1));
                floor = y as f64;
            }
            counts.push(cnt);
            rects.push(rs);
        }
        // 六成以上的列数出同一个更大的数
        let Some(&best) = counts.iter().max() else { continue };
        let agree = counts.iter().filter(|&&c| c == best).count();
        if best > n.div && agree * 5 >= counts.len() * 3 {
            if std::env::var("OMR_DIV_DEBUG").is_ok() {
                eprintln!("减时线逐列 音{} @{:.0},{:.0}：{} → {best}", n.digit, n.bbox.x, n.bbox.y, n.div);
            }
            n.div = best;
            n.alts.retain(|a| a.kind != AltKind::DivPlus);
            if let Some(i) = counts.iter().position(|&c| c == best) {
                out.claimed.extend(rects[i].iter().copied());
            }
        }
    }
    // 比本行线厚的中位厚出一倍的：两道粘成一道
    let ts: Vec<f64> = used.iter().map(|&i| thick(&lines[i])).collect();
    let med = dolce_omr_core::geom::median(&ts, 0.0);
    for (n, mine) in out.nums.iter_mut().zip(&taken) {
        if mine.iter().any(|&i| thick(&lines[i]) >= med * 1.8 && thick(&lines[i]) >= 3.0) && n.div < 4 {
            n.alts.push(Alt { kind: AltKind::DivPlus, cost: 0.8 });
        }
    }
    for i in used {
        let l = &lines[i];
        out.claimed.push(Rect::new(l.x0 as f64, l.y0 as f64, (l.x1 - l.x0 + 1) as f64, (l.y1 - l.y0 + 1) as f64));
    }
}

/// 数字正下方最低一道减时线的底（没有减时线回数字底）。
fn under_floor(n: &JpNum, claimed: &[Rect], h: f64) -> f64 {
    let cx = n.bbox.cx();
    claimed
        .iter()
        .filter(|l| l.x - h * 0.15 <= cx && cx <= l.right() + h * 0.15 && l.y >= n.bbox.bottom() - h * 0.1 && l.y - n.bbox.bottom() <= h * 1.1)
        .map(|l| l.bottom())
        .fold(n.bbox.bottom(), f64::max)
}

/// 八度点：数字正上方（高音）、减时线之下（低音）的小圆块（`skip`：已认成别的记号的块）。一个点只归横向最近的那个数字；上下各至多两个。
fn octave_dots(ink: &Ink, row: &RowFrame, out: &mut RowNotes, skip: &[i32]) {
    let h = row.h();
    let w = ink.w() as f64;
    let (ya, yb) = (row.top_at(0.0).min(row.top_at(w)) - h * 1.2, row.bottom_at(0.0).max(row.bottom_at(w)) + h * 1.6);
    let dots: Vec<&Comp> = ink.comps().iter().filter(|k| k.cy > ya && k.cy < yb && dot_like(k, h) && !skip.contains(&k.id)).collect();
    let floors: Vec<f64> = out.nums.iter().map(|n| under_floor(n, &out.claimed, h)).collect();
    // (点, 音, 上 / 下, 离数字多远)
    let mut hits: Vec<(usize, usize, bool, f64)> = Vec::new();
    for (di, d) in dots.iter().enumerate() {
        let near = out
            .nums
            .iter()
            .enumerate()
            .filter(|(_, n)| d.cx >= n.bbox.x - h * 0.12 && d.cx <= n.bbox.right() + h * 0.12)
            .min_by(|a, b| (a.1.bbox.cx() - d.cx).abs().total_cmp(&(b.1.bbox.cx() - d.cx).abs()));
        let Some((ni, n)) = near else { continue };
        if std::env::var("OMR_OCT_DEBUG").is_ok() {
            eprintln!("八度点 {:.0}x{:.0} @{:.0},{:.0} → 音{} @{:.0},{:.0} 上缝{:.1} 下缝{:.1}", d.rect.w, d.rect.h, d.rect.x, d.rect.y, n.digit, n.bbox.x, n.bbox.y, n.bbox.y - d.rect.bottom(), d.rect.y - floors[ni]);
        }
        let up_gap = n.bbox.y - d.rect.bottom();
        let dn_gap = d.rect.y - floors[ni];
        if up_gap >= -h * 0.08 && up_gap <= h * 0.75 {
            hits.push((di, ni, true, up_gap));
        } else if dn_gap >= -h * 0.06 && dn_gap <= h * 0.7 {
            hits.push((di, ni, false, dn_gap));
        }
    }
    // 本行（不够就全页）收得到的独立点的点径中位：线下探出来的粘点比它小一截的是字顶碎笔（青年诗歌 98 的 4×6 对 11×10）
    let diam = |r: &Rect| (r.w + r.h) / 2.0;
    let row_d: Vec<f64> = hits.iter().map(|t| diam(&dots[t.0].rect)).collect();
    let med_diam = if row_d.len() >= 3 { dolce_omr_core::geom::median(&row_d, 0.0) } else { 0.0 };
    for (ni, n) in out.nums.iter_mut().enumerate() {
        for up in [true, false] {
            let mut mine: Vec<&(usize, usize, bool, f64)> = hits.iter().filter(|t| t.1 == ni && t.2 == up).collect();
            mine.sort_by(|a, b| a.3.total_cmp(&b.3));
            // 第一个点贴着数字（或减时线），第二个贴着第一个
            let mut edge = 0.0;
            let mut cnt: i32 = 0;
            let mut first_cx: Option<f64> = None;
            for t in mine {
                let first = if up { h * 0.45 } else { h * 0.38 };
                if t.3 - edge > if cnt == 0 { first } else { h * 0.3 } || cnt >= 2 {
                    break;
                }
                // 第二个点正落在第一个点的正上 / 下方（错开半个点以上的是旁边的标点、别的记号）
                let d = dots[t.0];
                if first_cx.is_some_and(|c| (d.cx - c).abs() > d.rect.w * 0.5) {
                    break;
                }
                // 同一个音的两个八度点是同一个字模印的：包围盒面积不差出一倍（摞在点上的小字、碎渣在这里断）
                if let Some(&(pid, _, _)) = n.oct_dots.iter().rev().find(|o| o.1 == up) {
                    if cnt > 0 {
                        if let Some(p) = dots.iter().find(|k| k.id == pid) {
                            let (aa, ab) = (d.rect.w * d.rect.h, p.rect.w * p.rect.h);
                            if aa.min(ab) < aa.max(ab) * 0.5 {
                                break;
                            }
                        }
                    }
                }
                // 第二个下点：歌词字顶的点画（「初」的衤点）正摞在低音点下方，下面紧挨着字身；真低音点下方留白
                // （头一个点不用这条：歌词排得紧的行，真低音点下面不到 0.18 字号就是字顶）
                if !up && cnt > 0 && ink_below(ink, &d.rect, h) >= 0.12 {
                    break;
                }
                first_cx.get_or_insert(d.cx);
                cnt += 1;
                n.oct_dots.push((dots[t.0].id, up, t.3));
                edge = t.3 + dots[t.0].rect.h;
                if !up {
                    out.claimed.push(dots[t.0].rect);
                }
            }
            // 低音点粘在减时线底下（连通块里它不单独成块）：回原图在线底下开窗找一团不碰窗边的小圆墨
            if !up && cnt == 0 && n.div > 0 {
                if let Some(r) = probe_low_dot(ink, n.bbox.cx(), floors[ni], h).filter(|r| ink_below(ink, r, h) < 0.12 && diam(r) >= med_diam * 0.6) {
                    cnt = 1;
                    out.claimed.push(r);
                }
            }
            // 粘顶的高音点先记下，等低音点与上下行共用的点归定了再收（`lib::promote_glued_up`）
            if up && cnt == 0 {
                n.glued_up = probe_high_dot(ink, n.bbox.cx(), n.bbox.y, h).map(|r| n.bbox.y - r.bottom());
            }
            n.octave += if up { cnt } else { -cnt };
        }
        if n.digit == 0 || n.digit == crate::result::RHYTHM_DIGIT {
            n.octave = 0;
        }
    }
}

/// 点正下方紧挨着的一小条（0.18 字号高、左右各宽出 0.2 字号）里墨的占比（同 TS `inkBelow`）：字顶笔画与字身之间几乎不留空，
/// 真低音点到下一行歌词字顶还有半个点径。
fn ink_below(ink: &Ink, r: &Rect, h: f64) -> f64 {
    let y0 = r.bottom().round() as i64 + 1;
    let y1 = (r.bottom() + h * 0.18).round() as i64;
    let (x0, x1) = ((r.x - h * 0.2).round() as i64, (r.right() + h * 0.2).round() as i64);
    if y1 <= y0 || x1 <= x0 {
        return 0.0;
    }
    let tot = ((y1 - y0 + 1) * (x1 - x0 + 1)) as f64;
    let n = (y0..=y1).flat_map(|y| (x0..=x1).map(move |x| (x, y))).filter(|&(x, y)| ink.at(x, y)).count();
    n as f64 / tot
}

/// 粘在数字顶上的点，贴着数字那一行至多是它最宽一行的这么多倍。
const NECK: f64 = 0.85;

/// 在 `floor`（减时线底）下面、数字中线左右 0.32 字号的窗里找低音点：紧接着线的几行墨，横向不碰窗边、近圆、够实。
fn probe_low_dot(ink: &Ink, cx: f64, floor: f64, h: f64) -> Option<Rect> {
    probe_dot(ink, cx, floor.round() as i64, h, 1, false)
}

/// 高音点粘在数字顶上（粗体本、扫描件印糊的；有的上头还粘着弧）：从数字顶往上开窗找。
fn probe_high_dot(ink: &Ink, cx: f64, top: f64, h: f64) -> Option<Rect> {
    probe_dot(ink, cx, top.round() as i64 - 1, h, -1, true)
}

/// 从 `y0` 起朝 `dir`（1 向下、-1 向上）、在中线左右 0.32 字号的窗里找一团粘着别的墨的小圆点：
/// 先跳过粘着的那几行毛边，再收横向不碰窗边的窄行；这一团近圆、够实，过了它是空白（`capped`：或者压着一道横贯窗子的墨——弧）。
fn probe_dot(ink: &Ink, cx: f64, y0: i64, h: f64, dir: i64, capped: bool) -> Option<Rect> {
    let (xa, xb) = ((cx - h * 0.32).round() as i64, (cx + h * 0.32).round() as i64);
    let span = |y: i64| {
        let a = (xa..=xb).find(|&x| ink.at(x, y))?;
        let b = (xa..=xb).rev().find(|&x| ink.at(x, y))?;
        Some((a, b))
    };
    let small = |s: (i64, i64)| s.0 > xa && s.1 < xb && ((s.1 - s.0 + 1) as f64) <= h * 0.45;
    // 跳过毛边（至多 3 行）
    let mut y = y0;
    while (y - y0).abs() < 3 && span(y).is_some_and(|s| !small(s)) {
        y += dir;
    }
    let start = y;
    let (mut a, mut b, mut area) = (i64::MAX, i64::MIN, 0usize);
    // 贴着数字那一行的宽、最宽一行的宽
    let (mut neck, mut widest) = (0i64, 0i64);
    while let Some(s) = span(y).filter(|&s| small(s)) {
        if y == start {
            neck = s.1 - s.0 + 1;
        }
        widest = widest.max(s.1 - s.0 + 1);
        a = a.min(s.0);
        b = b.max(s.1);
        area += (s.0..=s.1).filter(|&x| ink.at(x, y)).count();
        y += dir;
        if (y - start).abs() as f64 > h * 0.45 {
            return None;
        }
    }
    if b < a {
        return None;
    }
    let (bw, bh) = ((b - a + 1) as f64, (y - start).abs() as f64);
    // 过了这一团：空白；压着弧的话那一行横贯窗子
    let beyond = span(y);
    let open = beyond.is_none() || (capped && beyond.is_some_and(|s| s.0 <= xa || s.1 >= xb));
    // 压着弧的那种得有脖子：圆点中间最宽，数字自己伸出带外的尖（「1」「4」的顶）贴着数字那头最宽
    if capped && neck as f64 > widest as f64 * NECK {
        return None;
    }
    if b < a || !open || bh < h * 0.1 || bw < h * 0.1 || bw / bh < 0.55 || bw / bh > 1.8 || (area as f64) < bw * bh * 0.55 {
        return None;
    }
    Some(Rect::new(a as f64, start.min(y - dir) as f64, bw, bh))
}
