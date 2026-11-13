//! 矢量页的**字行原语**：文字层的字（非音乐字体）逐字成行、按横向空当分段、按谱表分带，交给与位图同一份的
//! `text::classify`（歌词、和弦、力度、跳转、术语的分类与归属）与 `omr-text::header`（页眉分类）。
//!
//! 文字层的字是确定的，不用切条、不用 OCR、不用补词间空格：PDFium 按字距补出的空格（`generated`）就是词界。
//! 音乐字体里的力度字形（`dynamicMF` 等）身份确定，直接出力度记号，归最近的那行谱。
use super::glyphs::{music_family, VSym};
use crate::page::Layout;
use crate::text::classify::{Mark, RowText};
use crate::text::header::header_line_ok;
use crate::text::lines::{Band, GeoLine, Seg};
use dolce_omr_core::image::Rect;
use dolce_omr_sheet::score::Dir;
use dolce_omr_source::vector::VecPage;
use dolce_omr_text::header::{credits, Credit, WordLine};
use dolce_omr_text::spaces::{box_ink, recover_spaces, spread};
use dolce_omr_text::Ch;
use crate::attrs::DigitReader;
use dolce_omr_ocr::surface::Gray;
use dolce_omr_source::model::PageImage;

/// 同一行：基线相差不过字号的这个比例。
const SAME_BASE: f64 = 0.35;
/// 行内横向空当超过行高这么多倍就分段（同位图）。
const SEG_GAP: f64 = 2.0;
/// 首行上方、末行下方的带伸出去这么多格（同位图）。
const TOP_REACH: f64 = 9.0;
const BOTTOM_REACH: f64 = 24.0;
/// 页眉行底离第一行谱至少这么多格（同位图）。
const CLEAR: f64 = 0.3;
/// 小图并成一行：纵向交叠至少占矮的那块的这个比例、横向缝不过行高的这么多倍。
const TILE_OVERLAP: f64 = 0.5;
const TILE_GAP: f64 = 2.0;
/// 小图成行的字：基线取图底往上这么多个图高（方块字的字身底比基线略低）。
const TILE_DESC: f64 = 0.1;
/// 词界：两边的字隔开至少这么多个字号（PDFium 补出的空格要过它才算；没写空格的空当过它也算）。
const GEN_GAP: f64 = 0.25;
/// 渲染图 / 小图拼条上算墨的灰度门槛。
const INK_GRAY: u8 = 128;
/// 力度字形离所归谱行不过这么多格。
const DYN_REACH: f64 = 7.0;

/// 一个字（工作坐标）。
struct TC {
    /// 从小图 OCR 读出的（字位是按比例摊的，不拿它的空当判词界）。
    read: bool,
    /// 字体不可靠（从渲染图裁条读）。
    bad: bool,
    /// PDFium 按字距补出的空格（不是 PDF 里画的）。
    gen: bool,
    ch: char,
    rect: Rect,
    base: f64,
    size: f64,
    space: bool,
}

/// 文字层逐字成行（工作坐标）。音乐字体的字、页边外的不要。
/// `extra`：要插进字行的音乐字形（和弦里的升降号，记成 `b` / `#`）与外框；只并进纵向交叠、横向贴着（一个字号内）的行。
/// `tiles`：谱面大图以外的小图（页面坐标，逐字贴的汉字图），按行拼条送 `ocr` 读，字并进同基线的文字层行。
/// `rendered`：文字层有不可靠字体时的整页渲染图，那几段从它裁条重读。
pub fn text_lines(vp: &VecPage, ocr: Option<&dyn DigitReader>, rendered: Option<&Gray>, tiles: &[PageImage], extra: &[(char, Rect)]) -> Vec<GeoLine> {
    let reread = rendered.zip(ocr);
    let bad_fonts = dolce_omr_source::vector::unreliable_fonts_of(&vp.chars);
    let mut cs: Vec<TC> = Vec::new();
    for c in vp.chars.iter() {
        if music_family(&c.font).is_some() {
            continue;
        }
        let Some(ch) = char::from_u32(c.unicode) else { continue };
        // 补出的换行符（`\r\n`，字号 0、框落在行尾字上）不要；只有补出的 U+0020 是候选词界
        let space = ch.is_whitespace();
        if c.generated && ch != ' ' {
            continue;
        }
        let mut rect = vp.rect_of(&c.bbox);
        let base = (c.origin.1 - vp.origin.1) * vp.scale;
        // PDFium 补出的空格框落在前一个字的原点上（按 x 排会插到前一个字前面）、字号是 1：挪到前一个字的右缘，字号与基线借它的。
        // 字号为 0 的空格同样借
        let (size, base) = match cs.last() {
            Some(p) if space && (c.generated || c.size_scaled <= 0.0) => {
                if c.generated {
                    rect = Rect::new(p.rect.right(), p.rect.y, 0.0, p.rect.h);
                }
                (p.size, p.base)
            }
            _ => (c.size_scaled * vp.scale, base),
        };
        cs.push(TC { read: false, gen: c.generated, bad: bad_fonts.contains(&c.font), ch: if space { ' ' } else { ch }, rect, base, size, space });
    }
    let tcs = ocr.map(|o| tile_chars(vp, tiles, o)).unwrap_or_default();
    let n_layer = cs.len();
    cs.extend(tcs);
    // 按基线成行（文字层的次序就是排版次序，同一行的字连着；跨行的另起）。小图读出的字在最后，找全部的行
    let mut rows: Vec<Vec<TC>> = Vec::new();
    for (i, c) in cs.into_iter().enumerate() {
        let look = if i < n_layer { 6 } else { usize::MAX };
        let fit = rows.iter_mut().rev().take(look).find(|r| {
            let r0 = r.iter().find(|t| !t.space).unwrap_or(&r[0]);
            (r0.base - c.base).abs() <= SAME_BASE * r0.size.max(c.size) && (c.space || (r0.size - c.size).abs() <= 0.45 * r0.size.max(c.size))
        });
        match fit {
            Some(r) => r.push(c),
            None if !c.space => rows.push(vec![c]),
            None => {}
        }
    }
    for &(ch, rect) in extra {
        let (cy, cx) = (rect.y + rect.h / 2.0, rect.x + rect.w / 2.0);
        let hit = rows.iter_mut().find(|r| {
            let ink: Vec<&TC> = r.iter().filter(|t| !t.space).collect();
            let (y0, y1) = (ink.iter().map(|t| t.rect.y).fold(f64::MAX, f64::min), ink.iter().map(|t| t.rect.bottom()).fold(f64::MIN, f64::max));
            let size = ink.iter().map(|t| t.size).fold(0.0, f64::max);
            cy >= y0 - size * 0.2 && cy <= y1 + size * 0.2 && ink.iter().any(|t| cx - t.rect.right() <= size * 0.6 && cx - t.rect.right() >= -size * 0.2)
        });
        if let Some(r) = hit {
            let base = r[0].base;
            let size = r[0].size;
            r.push(TC { read: false, gen: false, bad: false, ch, rect, base, size, space: false });
        }
    }
    let mut out = Vec::new();
    for mut r in rows {
        r.sort_by(|a, b| a.rect.x.total_cmp(&b.rect.x));
        let ink: Vec<&TC> = r.iter().filter(|t| !t.space).collect();
        if ink.is_empty() {
            continue;
        }
        let y0 = ink.iter().map(|t| t.rect.y).fold(f64::MAX, f64::min);
        let y1 = ink.iter().map(|t| t.rect.bottom()).fold(f64::MIN, f64::max);
        let h = (y1 - y0).max(1.0);
        // 分段：两字之间空当超过行高的 SEG_GAP 倍
        let mut segs: Vec<Seg> = Vec::new();
        let mut cur: Vec<&TC> = Vec::new();
        let flush = |cur: &mut Vec<&TC>, segs: &mut Vec<Seg>| {
            while cur.last().is_some_and(|t| t.space) {
                cur.pop();
            }
            let ink: Vec<&&TC> = cur.iter().filter(|t| !t.space).collect();
            if !ink.is_empty() {
                let (x0, x1) = (ink.iter().map(|t| t.rect.x).fold(f64::MAX, f64::min), ink.iter().map(|t| t.rect.right()).fold(f64::MIN, f64::max));
                let (a, b) = (ink.iter().map(|t| t.rect.y).fold(f64::MAX, f64::min), ink.iter().map(|t| t.rect.bottom()).fold(f64::MIN, f64::max));
                let mut chars: Vec<Ch> = Vec::new();
                let mut prev_read = false;
                // 这一段自己写了空格的信它的空格；一个都没写的才按空当补词界
                let spaced = cur.iter().any(|t| t.space && !t.gen);
                for (k, t) in cur.iter().enumerate() {
                    if t.space && chars.last().is_none_or(|c| c.ch == ' ') {
                        continue;
                    }
                    // 补出来的空格：两边的字隔开不到字号的 GEN_GAP 是字距（字距大的字体），不是词界
                    if t.space && t.gen {
                        let prev = chars.last().map_or(t.rect.x, |c| c.x1);
                        let next = cur[k + 1..].iter().find(|u| !u.space).map_or(prev, |u| u.rect.x);
                        if next - prev < GEN_GAP * t.size {
                            continue;
                        }
                    }
                    // 中间没有空格字（有的软件词间只留空当、不写空格；小图读的汉字后面接文字层的英文）：空当过 GEN_GAP 个字号补一个。
                    // 小图读的字之间不补（字位是按比例摊的）
                    if !t.space && (if spaced { t.read != prev_read } else { !(t.read && prev_read) }) && chars.last().is_some_and(|c| c.ch != ' ' && t.rect.x - c.x1 >= GEN_GAP * t.size) {
                        let x = chars.last().unwrap().x1;
                        chars.push(Ch { ch: ' ', x0: x, x1: t.rect.x });
                    }
                    chars.push(Ch { ch: t.ch, x0: t.rect.x, x1: t.rect.right().max(t.rect.x + 0.1) });
                    prev_read = t.read;
                }
                let rect = Rect::new(x0, a, x1 - x0, b - a);
                // 段里过半是不可靠字体的字，或夹着控制字符（没有码位映射的字）：整段从渲染图裁条重读
                let bad = ink.iter().filter(|t| t.bad).count() * 2 > ink.len() || ink.iter().any(|t| t.ch.is_control());
                let chars = match (bad, reread) {
                    (true, Some((g, ocr))) => reread_strip(g, ocr, &rect).unwrap_or(chars),
                    _ => chars,
                };
                segs.push(Seg { chars, rect });
            }
            cur.clear();
        };
        let mut last_right = f64::MIN;
        for t in &r {
            if !t.space && !cur.is_empty() && t.rect.x - last_right > SEG_GAP * h {
                flush(&mut cur, &mut segs);
            }
            if t.space && cur.is_empty() {
                continue;
            }
            if !t.space {
                last_right = last_right.max(t.rect.right());
            }
            cur.push(t);
        }
        flush(&mut cur, &mut segs);
        if !segs.is_empty() {
            out.push(GeoLine { y0, y1, segs });
        }
    }
    out
}

/// 字行按谱表分带（同位图 `page_bands` 的带：首行上方、相邻两行之间、末行下方）。压在谱表里的行（连音数字、小节号）不要。
pub fn bands(f: &Layout, lines: Vec<GeoLine>) -> Vec<Band> {
    let n = f.staves.len();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| f.staves[a].ys[0].total_cmp(&f.staves[b].ys[0]));
    let Some(&first) = order.first() else { return Vec::new() };
    let s0 = &f.staves[first];
    // (上面那行谱, 下面那行谱, y0, y1)
    let mut spans: Vec<(Option<usize>, Option<usize>, f64, f64)> = vec![(None, Some(first), s0.ys[0] - TOP_REACH * s0.space(), s0.ys[0])];
    for (k, &si) in order.iter().enumerate() {
        let s = &f.staves[si];
        let next = order.get(k + 1).copied();
        let y1 = next.map_or(s.ys[4] + BOTTOM_REACH * s.space(), |ni| f.staves[ni].ys[0]);
        spans.push((Some(si), next, s.ys[4], y1));
    }
    let mut out: Vec<Band> = spans.iter().map(|&(a, b, _, _)| Band { above: a, below: b, lines: Vec::new() }).collect();
    for l in lines {
        let cy = (l.y0 + l.y1) / 2.0;
        if let Some(k) = spans.iter().position(|&(_, _, a, b)| cy >= a && cy < b) {
            out[k].lines.push(l);
        }
    }
    for b in out.iter_mut() {
        b.lines.sort_by(|a, c| a.y0.total_cmp(&c.y0));
    }
    out
}

/// 页眉：第一行谱上方（离谱表 [`CLEAR`] 格以外）的字行，按与位图同一份的筛选与分类。坐标按版面的 `up` 折回源图单位
/// （纯矢量页是页面点；混合页是大图像素，与 OCR 那一路的页眉同一坐标系），字号乘 `pt`（源图单位 → 点）。
pub fn header(f: &Layout, vp: &VecPage, lines: &[GeoLine], pt: f64) -> Vec<Credit> {
    let Some(first) = f.staves.iter().min_by(|a, b| a.ys[0].total_cmp(&b.ys[0])) else { return Vec::new() };
    let sp = first.space();
    let top = first.ys[0] + crate::text::header::band_lift(f, crate::text::header::first_index(f));
    let k = f.up;
    let mut wl: Vec<WordLine> = Vec::new();
    for l in lines.iter().filter(|l| l.y1 <= top - CLEAR * sp) {
        // 页眉的一行里左右几块（标题居中、词曲靠右）各算一条
        for s in &l.segs {
            let t: String = s.chars.iter().map(|c| c.ch).collect();
            let t = t.trim();
            if !header_line_ok(t, (top - s.rect.bottom()) / sp) {
                continue;
            }
            wl.push(WordLine { text: t.to_string(), x: s.rect.x / k, y: s.rect.y / k, w: s.rect.w / k, h: s.rect.h / k });
        }
    }
    let mut out = credits(&wl, 0.0, vp.w as f64 / k);
    for c in out.iter_mut() {
        c.size *= pt;
    }
    out
}

/// 混合页的页眉：OCR 那一路读出的与文字层的合在一起，框交叠的取文字层的（字是确定的）。
pub fn merge_credits(ocr: Vec<Credit>, layer: Vec<Credit>) -> Vec<Credit> {
    let over = |a: &Credit, b: &Credit| {
        let (ax, ay, aw, ah) = a.rect;
        let (bx, by, bw, bh) = b.rect;
        (ax + aw).min(bx + bw) > ax.max(bx) && (ay + ah).min(by + bh) > ay.max(by)
    };
    let mut out: Vec<Credit> = ocr.into_iter().filter(|c| !layer.iter().any(|v| over(c, v))).collect();
    out.extend(layer);
    out.sort_by(|a, b| a.rect.1.total_cmp(&b.rect.1));
    out
}

/// 音乐字体的力度字形 → 力度记号，归最近的那行谱（上下 [`DYN_REACH`] 格内）。分开画的字母（Doremi 的 m、f）挨着的拼成一个词。
pub fn dynamics(f: &Layout, syms: &[VSym], rows: &mut [RowText]) {
    let letter = |n: &str| -> Option<&'static str> {
        Some(match n.strip_prefix("dynamic")? {
            "Piano" => "p",
            "Forte" => "f",
            "Mezzo" => "m",
            "Rinforzando" => "r",
            "Sforzando" => "sfz",
            "Z" => "z",
            "PP" => "pp",
            "PPP" => "ppp",
            "MP" => "mp",
            "MF" => "mf",
            "FF" => "ff",
            "FFF" => "fff",
            _ => return None,
        })
    };
    let mut ds: Vec<(&VSym, &str)> = syms.iter().filter_map(|s| letter(s.name).map(|t| (s, t))).collect();
    ds.sort_by(|a, b| a.0.rect.x.total_cmp(&b.0.rect.x));
    let mut used = vec![false; ds.len()];
    for i in 0..ds.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let (mut text, mut r) = (ds[i].1.to_string(), ds[i].0.rect);
        for j in i + 1..ds.len() {
            let s = ds[j].0;
            if used[j] || s.rect.x - r.right() > 0.25 * s.em || (s.cy() - (r.y + r.h / 2.0)).abs() > 0.3 * s.em {
                continue;
            }
            if s.rect.x > r.right() + 0.25 * s.em {
                break;
            }
            used[j] = true;
            text.push_str(ds[j].1);
            let (x0, y0) = (r.x.min(s.rect.x), r.y.min(s.rect.y));
            r = Rect::new(x0, y0, r.right().max(s.rect.right()) - x0, r.bottom().max(s.rect.bottom()) - y0);
        }
        let Some(d) = dolce_omr_text::words::dynamic(&text) else { continue };
        let (cx, cy) = (r.cx(), r.y + r.h / 2.0);
        let best = (0..f.staves.len())
            .filter(|&i| cx >= f.staves[i].left - f.staves[i].space() && cx <= f.staves[i].right)
            .map(|i| {
                let st = &f.staves[i];
                let d = if cy < st.top(cx) { st.top(cx) - cy } else if cy > st.bottom(cx) { cy - st.bottom(cx) } else { 0.0 };
                (d / st.space(), i)
            })
            .filter(|&(d, _)| d <= DYN_REACH)
            .min_by(|a, b| a.0.total_cmp(&b.0));
        if let Some((_, si)) = best {
            rows[si].marks.push(Mark { x: cx, rect: r, dir: Dir::Dynamics(d.to_string()) });
        }
    }
}

/// 从渲染图（与工作坐标对齐）裁一段字的条送 OCR，字位折回工作坐标。
fn reread_strip(g: &Gray, ocr: &dyn DigitReader, r: &Rect) -> Option<Vec<Ch>> {
    let pad = (r.h * 0.25).max(3.0);
    let (x0, y0) = ((r.x - pad).max(0.0) as usize, (r.y - pad).max(0.0) as usize);
    let (x1, y1) = (((r.right() + pad) as usize).min(g.w), ((r.bottom() + pad) as usize).min(g.h));
    if x1 <= x0 + 2 || y1 <= y0 + 2 {
        return None;
    }
    let mut s = Gray::new(x1 - x0, y1 - y0, 255);
    for y in y0..y1 {
        s.data[(y - y0) * s.w..(y - y0 + 1) * s.w].copy_from_slice(&g.data[y * g.w + x0..y * g.w + x1]);
    }
    let out: Vec<Ch> = read_spaced(&s, ocr)?.into_iter().map(|c| Ch { ch: c.ch, x0: c.x0 + x0 as f64, x1: c.x1 + x0 as f64 }).collect();
    (!out.is_empty()).then_some(out)
}

/// 读一条灰度图：逐字（条内像素坐标），按条里的空白列补词间空格（OCR 不出空格；与位图页眉同一份 `recover_spaces`）。
fn read_spaced(s: &Gray, ocr: &dyn DigitReader) -> Option<Vec<Ch>> {
    let got = ocr.read_line(s)?;
    let w = s.w as f64;
    let mut out: Vec<Ch> = Vec::new();
    for c in got {
        spread(c.ch.chars().filter(|ch| !ch.is_whitespace()), c.x0 * w, c.x1 * w, &mut out);
    }
    let ink = |x: usize, y: usize| s.data[y * s.w + x] < INK_GRAY;
    let col = |x: usize| (0..s.h).any(|y| ink(x, y));
    let Some(bi) = box_ink(0, s.w as i64, 0, s.h as i64, |x| col(x as usize), |y| (0..s.w).any(|x| ink(x, y as usize))) else { return Some(out) };
    Some(recover_spaces(&out, &bi.blanks, bi.height, bi.left, bi.right))
}

/// 谱面大图以外的小图按行拼条（各取原分辨率、最近邻、重叠取深的）送 OCR，读出的字折回工作坐标。
fn tile_chars(vp: &VecPage, tiles: &[PageImage], ocr: &dyn DigitReader) -> Vec<TC> {
    let mut order: Vec<&PageImage> = tiles.iter().collect();
    order.sort_by(|a, b| a.rect.x.total_cmp(&b.rect.x));
    // 成行：每行 (并起来的页上框, 块)
    let mut rows: Vec<(Rect, Vec<&PageImage>)> = Vec::new();
    for t in order {
        let r = t.rect;
        let fit = rows.iter_mut().find(|(u, _)| {
            let ov = r.bottom().min(u.bottom()) - r.y.max(u.y);
            ov >= TILE_OVERLAP * r.h.min(u.h) && r.x - u.right() <= TILE_GAP * r.h.max(u.h) && r.right() >= u.x
        });
        match fit {
            Some((u, ts)) => {
                let (x0, y0) = (u.x.min(r.x), u.y.min(r.y));
                *u = Rect::new(x0, y0, u.right().max(r.right()) - x0, u.bottom().max(r.bottom()) - y0);
                ts.push(t);
            }
            None => rows.push((r, vec![t])),
        }
    }
    let mut out = Vec::new();
    for (u, ts) in rows {
        // 每点几像素：取各块里最细的
        let k = ts.iter().map(|t| t.w as f64 / t.rect.w).fold(0.0, f64::max);
        let pad = 0.25 * u.h;
        let (ox, oy) = (u.x - pad, u.y - pad);
        let (w, h) = (((u.w + 2.0 * pad) * k).ceil() as usize, ((u.h + 2.0 * pad) * k).ceil() as usize);
        if w < 4 || h < 4 || w > 20000 {
            continue;
        }
        let mut g = Gray::new(w, h, 255);
        for t in &ts {
            let (sx, sy) = (t.w as f64 / t.rect.w, t.h as f64 / t.rect.h);
            let (xa, ya) = (((t.rect.x - ox) * k).floor().max(0.0) as usize, ((t.rect.y - oy) * k).floor().max(0.0) as usize);
            let (xb, yb) = ((((t.rect.right() - ox) * k).ceil() as usize).min(w), (((t.rect.bottom() - oy) * k).ceil() as usize).min(h));
            for y in ya..yb {
                let v = ((((y as f64 + 0.5) / k + oy - t.rect.y) * sy) as usize).min(t.h - 1);
                for x in xa..xb {
                    let q = ((((x as f64 + 0.5) / k + ox - t.rect.x) * sx) as usize).min(t.w - 1);
                    let p = &mut g.data[y * w + x];
                    *p = (*p).min(t.gray[v * t.w + q]);
                }
            }
        }
        let Some(got) = read_spaced(&g, ocr) else { continue };
        let ur = vp.rect_of(&u);
        let size = ur.h;
        let base = ur.bottom() - TILE_DESC * size;
        // 条内像素 → 工作坐标
        let to = |x: f64| (x / k + ox - vp.origin.0) * vp.scale;
        for c in got {
            let (x0, x1) = (to(c.x0), to(c.x1));
            let space = c.ch == ' ';
            out.push(TC { read: true, gen: space, bad: false, ch: c.ch, rect: Rect::new(x0, ur.y, (x1 - x0).max(0.1), ur.h), base, size, space });
        }
    }
    out
}

/// 文字层的数（连着的阿拉伯数字并成一个，基线相同、字缝不过半个字号）与外框（工作坐标）：多小节休止上方的小节数之类。
pub fn numbers(vp: &VecPage) -> Vec<(u32, Rect)> {
    let mut out: Vec<(u32, Rect, f64, f64)> = Vec::new();
    for c in vp.chars.iter().filter(|c| !c.generated && music_family(&c.font).is_none()) {
        let Some(d) = char::from_u32(c.unicode).and_then(|ch| ch.to_digit(10)) else { continue };
        let r = vp.rect_of(&c.bbox);
        let (base, size) = ((c.origin.1 - vp.origin.1) * vp.scale, c.size_scaled * vp.scale);
        match out.last_mut() {
            Some((n, u, b, sz)) if (*b - base).abs() <= SAME_BASE * *sz && r.x - u.right() <= 0.5 * *sz && r.x >= u.x => {
                *n = *n * 10 + d;
                *u = Rect::new(u.x, u.y.min(r.y), r.right() - u.x, u.bottom().max(r.bottom()) - u.y.min(r.y));
            }
            _ => out.push((d, r, base, size)),
        }
    }
    out.into_iter().map(|(n, r, _, _)| (n, r)).collect()
}
