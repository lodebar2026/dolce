//! JM1 框架结构：数字高、数字行（等高数字成排）、行带（上下沿随 x 的直线）、带内切格（数字 / 小节线 / 增时线 / 点）。
//!
//! 行带之内只有音符本体：八度点、弧在带上方，减时线、低音点、歌词在带下方。带内逐列看有没有墨切成格，
//! 所以数字与上下的线、点、弧粘成一块连通块也不要紧——认数字不靠连通块外框。
use crate::prep::{Comp, Ink};
use dolce_omr_core::geom::median;
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::surface::Gray;

/// 数字高（字号）的估计。近方块的中位高为底；汉字碎块压低、歌词字压高时，改信「夹在小节线之间的瘦高块」。
pub fn estimate_num_h(comps: &[Comp]) -> f64 {
    let ratio = |k: &Comp| k.rect.w / k.rect.h;
    let hs = |ks: &[&Comp]| ks.iter().map(|k| k.rect.h).collect::<Vec<_>>();
    let squarish: Vec<&Comp> = comps.iter().filter(|k| ratio(k) > 0.35 && ratio(k) < 1.6 && k.rect.h >= 6.0).collect();
    let est = median(&hs(&squarish), 16.0);
    let tall: Vec<&Comp> = squarish.iter().copied().filter(|k| ratio(k) <= 0.85).collect();
    let est2 = if tall.len() >= 20 { median(&hs(&tall), 0.0) } else { 0.0 };
    // 小节线：细高竖条。数字在它纵向中段、横向几个线高以内；歌词在线外，挨不上
    let bars: Vec<&Comp> = comps.iter().filter(|k| k.rect.h >= 12.0 && k.rect.w <= (k.rect.h * 0.12).max(3.0)).collect();
    let anchor_of = |ks: &[&Comp]| -> Vec<f64> {
        if bars.len() < 3 {
            return Vec::new();
        }
        ks.iter()
            .filter(|k| bars.iter().any(|b| b.rect.h >= k.rect.h * 1.2 && (b.rect.x - k.rect.x).abs() <= b.rect.h * 6.0 && (b.rect.cy() - k.rect.cy()).abs() < b.rect.h * 0.3))
            .map(|k| k.rect.h)
            .collect()
    };
    let refh = median(&anchor_of(&tall), 0.0);
    let mut slim = tall.clone();
    slim.extend(comps.iter().filter(|k| k.rect.h >= 6.0 && ratio(k) > 0.2 && ratio(k) <= 0.35 && (refh == 0.0 || k.rect.h <= refh * 1.15)));
    let anchored = anchor_of(&slim);
    let n = anchored.len() as f64;
    let raw3 = if anchored.len() >= 15 || (anchored.len() >= 5 && n >= slim.len() as f64 * 0.6) { median(&anchored, 0.0) } else { 0.0 };
    let tight = raw3 > 0.0 && anchored.iter().filter(|&&h| (h - raw3).abs() <= raw3 * 0.06).count() as f64 >= n * 0.85;
    let est3 = if raw3 > 0.0 && (n >= slim.len() as f64 * 0.2 || tight) { raw3 } else { 0.0 };
    if est3 > 0.0 && ((est > est3 * 1.15 && est3 >= est * 0.6) || (est3 > est * 1.2 && est2 > 0.0 && (est3 - est2).abs() <= est3 * 0.1) || (est3 > est * 1.2 && tight)) {
        return est3;
    }
    if est2 > est * 1.3 { est2 } else { est }
}

/// 行带：上下沿各一条同斜率的直线。
#[derive(Clone, Copy, Debug)]
pub struct Band {
    pub slope: f64,
    pub top0: f64,
    pub bottom0: f64,
}

impl Band {
    pub fn top(&self, x: f64) -> f64 {
        self.top0 + self.slope * x
    }
    pub fn bottom(&self, x: f64) -> f64 {
        self.bottom0 + self.slope * x
    }
    pub fn h(&self) -> f64 {
        self.bottom0 - self.top0
    }
    /// 数字框 → 行带：斜率取各框中心的最小二乘（样本少或太窄时不取），上下沿取去掉斜率后的中位。
    fn fit(rs: &[Rect]) -> Band {
        let h = median(&rs.iter().map(|r| r.h).collect::<Vec<_>>(), 1.0);
        // 斜率：隔得够远的两两连线斜率的中位（个别离群的框带不偏）
        let mut ks: Vec<f64> = Vec::new();
        for (i, a) in rs.iter().enumerate() {
            for b in &rs[i + 1..] {
                let dx = b.cx() - a.cx();
                if dx.abs() >= h * 4.0 {
                    ks.push((b.cy() - a.cy()) / dx);
                }
            }
        }
        let slope = if ks.len() >= 6 { median(&ks, 0.0).clamp(-0.03, 0.03) } else { 0.0 };
        let top0 = median(&rs.iter().map(|r| r.y - slope * r.cx()).collect::<Vec<_>>(), 0.0);
        let bottom0 = median(&rs.iter().map(|r| r.bottom() - slope * r.cx()).collect::<Vec<_>>(), 0.0);
        Band { slope, top0, bottom0 }
    }
}

/// 带内一格是什么。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CellKind {
    /// 小节线（`thick`：比本页细线粗得多的那种，终止线 / 反复线的粗线）
    Bar { thick: bool },
    /// 数字候选（读数在音符层）
    Digit,
    /// 增时线
    Dash,
    /// 附点
    Dot,
    /// 上下两个点（反复记号的冒号）
    Colon,
    Other,
}

/// 带内一格：列范围与格里墨的纵向范围（都含端点）。
#[derive(Clone, Copy, Debug)]
pub struct Cell {
    pub x0: i64,
    pub x1: i64,
    pub y0: i64,
    pub y1: i64,
    pub kind: CellKind,
}

impl Cell {
    pub fn rect(&self) -> Rect {
        Rect::new(self.x0 as f64, self.y0 as f64, (self.x1 - self.x0 + 1) as f64, (self.y1 - self.y0 + 1) as f64)
    }
    pub fn w(&self) -> f64 {
        (self.x1 - self.x0 + 1) as f64
    }
    pub fn h(&self) -> f64 {
        (self.y1 - self.y0 + 1) as f64
    }
    pub fn cx(&self) -> f64 {
        (self.x0 + self.x1) as f64 / 2.0
    }
}

/// 一行谱的框架：行带与带内各格（按 x 排）。
#[derive(Clone, Debug)]
pub struct RowFrame {
    pub band: Band,
    pub cells: Vec<Cell>,
}

impl RowFrame {
    pub fn h(&self) -> f64 {
        self.band.h()
    }
    /// 行的中线 y（取页中）。
    pub fn top_at(&self, x: f64) -> f64 {
        self.band.top(x)
    }
    pub fn bottom_at(&self, x: f64) -> f64 {
        self.band.bottom(x)
    }
    pub fn digits(&self) -> impl Iterator<Item = &Cell> {
        self.cells.iter().filter(|c| c.kind == CellKind::Digit)
    }
    pub fn bars(&self) -> impl Iterator<Item = &Cell> {
        self.cells.iter().filter(|c| matches!(c.kind, CellKind::Bar { .. }))
    }
}

/// 数字格送检的画面：墨的外框等比缩进 64×64 的白格、四周留 8。
pub fn digit_cell(ink: &Ink, r: &Rect) -> Gray {
    dolce_omr_ocr::surface::fit_cell(&ink.crop_bin(r))
}

/// rec 读出的字 → 简谱数字：0–7；`X` 是节奏音符（9）；别的不是数字。
pub fn digit_of(text: &str) -> Option<u8> {
    let t = text.trim();
    if let Some(c) = t.chars().find(|c| ('0'..='7').contains(c)) {
        return Some(c as u8 - b'0');
    }
    match t {
        "X" | "x" | "Ｘ" | "ｘ" | "×" => Some(crate::result::RHYTHM_DIGIT),
        "O" | "o" | "Q" | "D" | "〇" | "○" => Some(0),
        "l" | "I" | "|" | "丨" | "]" | "[" => Some(1),
        "S" | "s" => Some(5),
        "Z" | "z" => Some(2),
        "b" => Some(6),
        _ => None,
    }
}

/// 粗体小图把 3 / 5 / 6 的开口糊成闭环读成 8 / B：取 OCR 候选里排最前的 0–7。
pub fn alt_digit(ocr: &CachedOcr, img: &Gray) -> Option<u8> {
    let r = ocr.rank_chars(img, 10).ok()?;
    r.first().and_then(|c| c.alts.iter().find_map(|a| a.chars().next().filter(|c| ('0'..='7').contains(c) && a.chars().count() == 1))).map(|c| c as u8 - b'0')
}

/// 整格只读出一个 0–7。
fn strict_digit(t: &str) -> Option<u8> {
    let t = t.trim();
    t.chars().next().filter(|c| ('0'..='7').contains(c) && t.chars().count() == 1).map(|c| c as u8 - b'0')
}

/// 找数字行。数字样的连通块（瘦高、与字号等高）按纵向中心聚成排，一排里多数读得出数字的是谱行的种子；
/// 由种子定行带，再在带内切格。只有两三个数字又没有小节线的排（曲号、拍号）不算。
pub fn find_rows(ink: &Ink, num_h: f64, ocr: &CachedOcr) -> Vec<RowFrame> {
    find_rows_in(ink, num_h, ocr, false)
}

/// 同 [`find_rows`]。`known`：这张图已知是一条简谱行（混排谱里按小节线对齐切下来的条），不再拿「多数格读得出数字」筛——
/// 条里夹着的说明文字、行首的标志会把比例拉低。
pub fn find_rows_in(ink: &Ink, num_h: f64, ocr: &CachedOcr, known: bool) -> Vec<RowFrame> {
    let rows = find_rows_at(ink, num_h, ocr, known);
    // 字号估偏了（数字又宽又扁的字体、歌词字比数字多得多的页）：头一遍认下的行带高才是本页的数字高，照它再找一遍——
    // 候选的高宽门都按字号开，估小了宽数字进不来、一行只剩几个「1」「7」定带
    let hs: Vec<f64> = rows.iter().map(|r| r.h()).collect();
    let mh = median(&hs, num_h);
    if rows.len() >= 2 && (mh - num_h).abs() > num_h * RESCALE {
        let again = find_rows_at(ink, mh, ocr, known);
        if again.len() >= rows.len() {
            return again;
        }
    }
    rows
}

/// 矮排的底离下面正常行的顶不到带高的这么多倍，是骑在那一行上的倚音。
const PERCH: f64 = 0.5;
/// 头一遍认下的行带高与估的字号差出这么多就照带高重找。
const RESCALE: f64 = 0.1;

fn find_rows_at(ink: &Ink, num_h: f64, ocr: &CachedOcr, known: bool) -> Vec<RowFrame> {
    let cand: Vec<&Comp> = ink
        .comps()
        .iter()
        .filter(|k| k.rect.h >= num_h * 0.72 && k.rect.h <= num_h * 1.3 && k.rect.w >= k.rect.h * 0.18 && k.rect.w <= num_h * 1.05)
        .collect();
    let cells: Vec<Gray> = cand.iter().map(|k| digit_cell(ink, &k.rect)).collect();
    let read: Vec<Option<u8>> = match ocr.read_cells(&cells) {
        Ok(v) => v.iter().map(|t| strict_digit(t)).collect(),
        Err(_) => return Vec::new(),
    };
    // 按中心 y 排，相邻差不过 0.3 字号的连成一排
    let mut order: Vec<usize> = (0..cand.len()).collect();
    order.sort_by(|&a, &b| cand[a].rect.cy().total_cmp(&cand[b].rect.cy()));
    let mut lines: Vec<Vec<usize>> = Vec::new();
    for i in order {
        match lines.last_mut() {
            Some(l) if cand[i].rect.cy() - cand[*l.last().unwrap()].rect.cy() <= num_h * 0.3 => l.push(i),
            _ => lines.push(vec![i]),
        }
    }
    let mut rows: Vec<RowFrame> = Vec::new();
    // 各行数字格里真读得出数字的比例
    let mut ratios: Vec<f64> = Vec::new();
    for l in lines {
        let mut digits: Vec<Rect> = l.iter().filter(|&&i| read[i].is_some()).map(|&i| cand[i].rect).collect();
        if std::env::var("OMR_JP_DEBUG").is_ok() && l.len() >= 3 {
            eprintln!("排 y{:.0} 块{} 读出数字{}", cand[l[0]].rect.cy(), l.len(), digits.len());
        }
        // 与旋律同排、隔着一大段空白的一段说明文字（谱旁的附注）把整排的数字比例拉低：按大空白分簇，各簇自己论
        let mut span: Option<(f64, f64)> = None;
        if !known && !digits.is_empty() && (digits.len() as f64) < l.len() as f64 * 0.5 {
            let mut by_x: Vec<usize> = l.clone();
            by_x.sort_by(|&a, &b| cand[a].rect.x.total_cmp(&cand[b].rect.x));
            let mut clusters: Vec<Vec<usize>> = Vec::new();
            for i in by_x {
                match clusters.last_mut() {
                    Some(c) if cand[i].rect.x - cand[*c.last().unwrap()].rect.right() <= num_h * CLUSTER_GAP => c.push(i),
                    _ => clusters.push(vec![i]),
                }
            }
            let ok = |c: &Vec<usize>| {
                let d = c.iter().filter(|&&i| read[i].is_some()).count();
                d >= 3 && d as f64 >= c.len() as f64 * 0.5
            };
            if std::env::var("OMR_JP_DEBUG").is_ok() {
                for c in &clusters {
                    eprintln!("   簇 x{:.0}-{:.0} 块{} 数字{}", cand[c[0]].rect.x, cand[*c.last().unwrap()].rect.right(), c.len(), c.iter().filter(|&&i| read[i].is_some()).count());
                }
            }
            // 只认一簇读得出数字的：行的左右界收到邻簇半个字号以外（行末的反复线、增时线留在行里）
            if clusters.len() >= 2 && clusters.iter().filter(|c| ok(c)).count() == 1 {
                let k = clusters.iter().position(ok).unwrap();
                let lo = if k == 0 { f64::NEG_INFINITY } else { cand[*clusters[k - 1].last().unwrap()].rect.right() + num_h * 0.5 };
                let hi = if k + 1 == clusters.len() { f64::INFINITY } else { cand[clusters[k + 1][0]].rect.x - num_h * 0.5 };
                digits.retain(|r| r.x >= lo && r.right() <= hi);
                span = Some((lo, hi));
            }
        }
        if digits.is_empty() || (!known && span.is_none() && (digits.len() as f64) < l.len() as f64 * 0.5) {
            continue;
        }
        // 同一排里高度离群的不参加定带（拍号、曲号的大字）
        let mh = median(&digits.iter().map(|r| r.h).collect::<Vec<_>>(), num_h);
        let core: Vec<Rect> = digits.iter().copied().filter(|r| (r.h - mh).abs() <= mh * 0.12).collect();
        if core.is_empty() || (mh - num_h).abs() > num_h * 0.4 {
            continue;
        }
        let band = Band::fit(&core);
        if rows.iter().any(|r| (r.band.top(0.0) - band.top(0.0)).abs() < band.h() * 0.5) {
            continue;
        }
        let mut row = RowFrame { band, cells: cut_cells(ink, &band) };
        if let Some((lo, hi)) = span {
            row.cells.retain(|c| c.x0 as f64 >= lo && c.x1 as f64 <= hi);
        }
        drop_aside(&mut row);
        let nd = row.digits().count();
        let nb = row.bars().count();
        // 带内切出的数字格多数得真读得出数字（歌词行里夹着段号、汉字的竖笔伸出带外像小节线）
        let imgs: Vec<Gray> = row.digits().map(|c| digit_cell(ink, &c.rect())).collect();
        let good = ocr.read_cells(&imgs).map_or(0, |v| {
            // 读成 8 / B 的照候选再认一遍（迦南诗选 1940 小图粗体，一行的 6、3 全读成 B、8，整行丢）
            v.iter().zip(&imgs).filter(|(t, img)| strict_digit(t).is_some() || (matches!(t.trim(), "8" | "B") && alt_digit(ocr, img).is_some())).count()
        });
        if std::env::var("OMR_JP_DEBUG").is_ok() {
            eprintln!("  带 y{:.0} 高{:.0} 数字格{nd} 读出{good} 线{nb}", band.top0, band.h());
        }
        if !known && (good as f64) < nd as f64 * 0.6 {
            continue;
        }
        // 没有一道可信小节线（细的——不过 0.2 字号，或旁边一个字号内另有一道线作伴的粗线）的排整排读一遍：读出两个以上汉字的是标题排
        //（迦南 1811「1811 心 愿」：曲号读得出数字、「愿」左边那一竖粗而实心、比数字高，像终止线的粗线）。
        // 行首印「前奏」「尾声」的谱行有真小节线，不读
        let credible = row.bars().any(|c| {
            let h = row.h();
            let thin = c.w() <= (h * 0.2).max(3.0);
            let pair = row.bars().any(|o| !std::ptr::eq(o, c) && ((o.x0 - c.x1).max(c.x0 - o.x1) as f64) <= h);
            thin || pair
        });
        if !credible && !known {
            let (x0, x1) = (row.cells.iter().map(|c| c.x0).min().unwrap_or(0), row.cells.iter().map(|c| c.x1).max().unwrap_or(0));
            let y0 = row.cells.iter().map(|c| c.y0).min().unwrap_or(0);
            let y1 = row.cells.iter().map(|c| c.y1).max().unwrap_or(0);
            let strip = ink.strip(&Rect::new(x0 as f64, y0 as f64, (x1 - x0 + 1) as f64, (y1 - y0 + 1) as f64), 4);
            let han = ocr.read_line(&strip).map_or(0, |v| v.iter().filter(|c| c.ch.chars().any(dolce_omr_text::chars::is_han)).count());
            if han >= 2 {
                if std::env::var("OMR_JP_DEBUG").is_ok() {
                    eprintln!("  读出汉字 {han}，不收");
                }
                continue;
            }
        }
        // 调号行（「1=B 4/4」与标题同排）：头一个数字后面紧跟着等号——上下两道短横；这种排里至多一根像小节线的竖笔
        if nb <= 1 && key_line(ink, &row) {
            if std::env::var("OMR_JP_DEBUG").is_ok() {
                eprintln!("  调号行，不收");
            }
            continue;
        }
        let span = row.digits().map(|c| c.x1).max().unwrap_or(0) - row.digits().map(|c| c.x0).min().unwrap_or(0);
        if nd >= 1 && (nb >= 1 || (nd >= 4 && span as f64 >= ink.w() as f64 * 0.3)) {
            rows.push(row);
            ratios.push(good as f64 / nd as f64);
        }
    }
    // 三行以上时，比各行带高的中位矮一成半以上的排（页眉里的年份、英文署名，歌词里夹的数字）得几乎格格读得出数字、还得有小节线才算谱行
    if rows.len() >= 3 {
        let mh = median(&rows.iter().map(|r| r.h()).collect::<Vec<_>>(), num_h);
        // 矮一截又紧贴在正常行顶上的一排是那一行的倚音（底下压着减时线、伸上来的小节线也穿过它），不是谱行
        let perched = |r: &RowFrame| rows.iter().any(|o| o.h() >= mh * 0.85 && o.band.top0 > r.band.top0 && o.band.top0 - r.band.bottom0 < mh * PERCH);
        let keep: Vec<bool> = rows.iter().zip(&ratios).map(|(r, &q)| r.h() >= mh * 0.85 || (q >= 0.85 && r.bars().count() > 0 && !perched(r))).collect();
        let mut it = keep.iter();
        rows.retain(|_| *it.next().unwrap());
    }
    rows.sort_by(|a, b| a.band.top0.total_cmp(&b.band.top0));
    settle_dots(&mut rows);
    settle_bars(ink, &mut rows);
    drop_bracket_cells(ink, &mut rows);
    rows
}

/// 连谱号（竖线、方括号、花括号）落在行带里的那一截被切成了格（赞美诗歌 946 的花括号读成音「1」）：跨两行以上、不贴纸边的竖高块，
/// 它横向范围里、排在各行行首的格拿掉（与 [`systems`] 同一筛法）。
fn drop_bracket_cells(ink: &Ink, rows: &mut [RowFrame]) {
    if rows.len() < 2 {
        return;
    }
    let h = median(&rows.iter().map(|r| r.h()).collect::<Vec<_>>(), 1.0);
    let pw = ink.w() as f64;
    // 各行括着它的竖高块（双竖线、方括号的钩常是并排几块）：行首排在这些块横向范围里的格都拿掉
    let mut spans: Vec<Vec<(f64, f64)>> = vec![Vec::new(); rows.len()];
    for k in ink.comps().iter().filter(|k| k.rect.h >= h * 2.2 && k.rect.w <= h * 1.2 && k.rect.x > 2.0 && k.rect.right() < pw - 2.0) {
        let inside: Vec<usize> = (0..rows.len()).filter(|&i| rows[i].bottom_at(k.cx) > k.rect.y && rows[i].top_at(k.cx) < k.rect.bottom()).collect();
        if inside.len() < 2 || (inside.len() == rows.len() && rows.len() >= 5) {
            continue;
        }
        for &i in &inside {
            spans[i].push((k.rect.x - 1.0, k.rect.right() + 1.0));
        }
    }
    for (row, sp) in rows.iter_mut().zip(&spans) {
        let cells = &mut row.cells;
        // 行首（第一个落在括号外的数字 / 小节线格之前）落在括号里的格；纸边的碎屑格夹在前头不挡
        let inside = |c: &Cell| sp.iter().any(|&(a, b)| c.x0 as f64 >= a && c.x1 as f64 <= b);
        let Some(first) = cells.iter().position(|c| !inside(c) && c.kind != CellKind::Other) else { continue };
        let mut i = 0;
        cells.retain(|c| {
            i += 1;
            !(i <= first && inside(c))
        });
    }
}

/// 同排的墨按这么宽（字号的倍数）的空白分簇：旋律里音与音之间、说明文字的字与字之间都到不了。
const CLUSTER_GAP: f64 = 3.0;
/// 一行旋律里不会有这么宽（带高的倍数）的空白。
const ASIDE_GAP: f64 = 8.0;
/// 隔在大空白外头的一小簇至多这么多格。
const ASIDE_MAX: usize = 10;

/// 与旋律印在同一排、隔着一大段空白的一小簇（「C/A 4/4」后面接前奏，行末的「D.S.」「Fine」）不是音符：
/// 空白一侧没有小节线、格又少的那一簇从行里拿掉（它的字由页眉、上方带去读）。
fn drop_aside(row: &mut RowFrame) {
    let h = row.h();
    let solid: Vec<usize> = (0..row.cells.len()).filter(|&i| row.cells[i].kind != CellKind::Other).collect();
    let Some(k) = (1..solid.len()).max_by_key(|&k| row.cells[solid[k]].x0 - row.cells[solid[k - 1]].x1) else { return };
    if ((row.cells[solid[k]].x0 - row.cells[solid[k - 1]].x1) as f64) < h * ASIDE_GAP {
        return;
    }
    let bar = |i: &usize| matches!(row.cells[*i].kind, CellKind::Bar { .. });
    let (left, right) = solid.split_at(k);
    let (lb, rb) = (left.iter().any(bar), right.iter().any(bar));
    let cut_x = (row.cells[solid[k - 1]].x1 + row.cells[solid[k]].x0) / 2;
    if !lb && rb && left.len() <= ASIDE_MAX {
        row.cells.retain(|c| c.x0 > cut_x);
    } else if lb && !rb && right.len() <= ASIDE_MAX && right.len() * 2 < left.len() {
        row.cells.retain(|c| c.x1 < cut_x);
    }
}

/// 细竖条：宽不过带高的这么多倍。
const STROKE_W: f64 = 0.3;
/// 本页小节线比行带高出这么多（相对带高）以上，才拿高度分小节线与「1」（数字排版的本子小节线与数字等高，分不了）。
const BAR_TALLER: f64 = 0.12;
/// 竖条的高落在「带高」与「本页小节线高」之间的这个分位以上算小节线。
const BAR_SPLIT: f64 = 0.5;

/// 小节线与数字「1」按**本页小节线的统计高度**分：先拿伸出行带一大截的细竖条当确定的小节线，量出它们通高（相对带高）的中位；
/// 别的细竖条——带内切出来读成数字的、勉强够上伸出量当了小节线的——通高离这个中位近的是小节线、离带高近的是「1」。
fn settle_bars(ink: &Ink, rows: &mut [RowFrame]) {
    // 各细竖条的通高比（穿过带中线的那段墨的全长 / 带高）
    let tall_of = |r: &RowFrame, c: &Cell| -> Option<f64> {
        let h = r.h();
        if c.h() < h * 0.9 || c.w() > (h * STROKE_W).max(4.0) || !matches!(c.kind, CellKind::Digit | CellKind::Bar { .. }) {
            return None;
        }
        (c.x0..=c.x1).filter_map(|x| overshoot(ink, &r.band, x)).map(|(up, dn)| (h + up + dn) / h).max_by(|a, b| a.total_cmp(b))
    };
    let sure: Vec<f64> = rows.iter().flat_map(|r| r.cells.iter().filter(|c| matches!(c.kind, CellKind::Bar { .. })).filter_map(|c| tall_of(r, c)).filter(|&t| t >= 1.0 + BAR_TALLER)).collect();
    let bars = rows.iter().map(|r| r.bars().count()).sum::<usize>();
    // 多数小节线都明显高过行带的页才分
    if sure.len() < 4 || sure.len() * 3 < bars * 2 {
        return;
    }
    let bar_h = median(&sure, 0.0);
    let cut = 1.0 + (bar_h - 1.0) * BAR_SPLIT;
    for r in rows.iter_mut() {
        let ts: Vec<Option<f64>> = r.cells.iter().map(|c| tall_of(r, c)).collect();
        for (c, t) in r.cells.iter_mut().zip(ts) {
            let Some(t) = t else { continue };
            match c.kind {
                CellKind::Digit if t >= cut => c.kind = CellKind::Bar { thick: false },
                _ => {}
            }
        }
    }
}

/// 墨占外框这么多的竖条是实心的。
const SOLID: f64 = 0.9;
/// 增时线至少这么扁（宽 / 高）。
const DASH_FLAT: f64 = 1.8;
/// 扁到这个程度以下的短横是「说不准」的：细体字的附点是个扁圆，密排本的增时线是一截短横，两样的宽高差不多。
const DASH_SURE: f64 = 2.6;
/// 宽到带高的这么多倍的增时线是长线。
const DASH_LONG: f64 = 0.6;

/// 说不准的短横（[`DASH_FLAT`]–[`DASH_SURE`]、又不长）照本页的排法定：这一页的增时线是长线的（有两条以上），短的扁块是附点；
/// 没有长线的页照扁度当增时线（密排本一律短线，附点另是更小更圆的点）。
fn settle_dots(rows: &mut [RowFrame]) {
    let long: Vec<f64> = rows.iter().flat_map(|r| r.cells.iter().filter(|c| c.kind == CellKind::Dash && c.w() >= r.h() * DASH_LONG).map(|c| c.w())).collect();
    if long.len() < 2 {
        return;
    }
    // 比本页长线的一半还短的才是点（印断的、收笔淡掉半截的长线不算）
    let lim = median(&long, 0.0) * DOT_OF_DASH;
    for r in rows.iter_mut() {
        for c in r.cells.iter_mut().filter(|c| c.kind == CellKind::Dash && c.w() < lim && c.w() < c.h() * DASH_SURE) {
            c.kind = CellKind::Dot;
        }
    }
}

/// 说不准的短横宽不到本页长增时线中位宽的这么多倍才改判附点。
const DOT_OF_DASH: f64 = 0.4;

/// 头一个数字后面紧跟着等号（上下两道短横、各自又扁又薄）的排是调号行。
fn key_line(ink: &Ink, row: &RowFrame) -> bool {
    let h = row.h();
    let Some(i) = row.cells.iter().position(|c| c.kind == CellKind::Digit) else { return false };
    let Some(c) = row.cells.get(i + 1) else { return false };
    if c.kind == CellKind::Digit || c.w() < h * 0.25 || (c.x0 - row.cells[i].x1) as f64 > h * 0.6 {
        return false;
    }
    let mut groups: Vec<(i64, i64)> = Vec::new();
    for y in c.y0..=c.y1 {
        if ink.row_ink(y, c.x0, c.x1 + 1) {
            match groups.last_mut() {
                Some(g) if g.1 == y - 1 => g.1 = y,
                _ => groups.push((y, y)),
            }
        }
    }
    groups.len() == 2 && groups.iter().all(|g| ((g.1 - g.0 + 1) as f64) <= h * 0.25)
}

/// 带内切格并分类。
fn cut_cells(ink: &Ink, band: &Band) -> Vec<Cell> {
    let w = ink.w() as i64;
    let h = band.h();
    let rows_of = |x: i64| (band.top(x as f64).round() as i64, band.bottom(x as f64).round() as i64 - 1);
    let col = |x: i64| {
        let (t, b) = rows_of(x);
        (t + 1..b).any(|y| ink.at(x, y))
    };
    let mut cells: Vec<Cell> = Vec::new();
    let mut x = 0;
    while x < w {
        if !col(x) {
            x += 1;
            continue;
        }
        let x0 = x;
        while x < w && col(x) {
            x += 1;
        }
        cells.push(Cell { x0, x1: x - 1, y0: 0, y1: 0, kind: CellKind::Other });
    }
    // 格里墨的纵向范围
    let extent = |c: &mut Cell| {
        let (mut y0, mut y1) = (i64::MAX, i64::MIN);
        for x in c.x0..=c.x1 {
            let (t, b) = rows_of(x);
            for y in t..=b {
                if ink.at(x, y) {
                    y0 = y0.min(y);
                    y1 = y1.max(y);
                }
            }
        }
        c.y0 = y0;
        c.y1 = y1;
    };
    cells.iter_mut().for_each(extent);
    cells.retain(|c| c.y1 >= c.y0);
    // 并排粘在一起的数字按本行数字宽切开
    let tall = |c: &Cell| c.h() >= h * 0.72;
    // 本行数字宽：近方形的宽体数字也算（只收到九成高的话，宽体页里只剩「1」定宽，个个数字被当成两个粘在一起切开）
    let ws: Vec<f64> = cells.iter().filter(|c| tall(c) && c.w() >= c.h() * 0.4 && c.w() <= c.h() * 1.15).map(|c| c.w()).collect();
    let med_w = median(&ws, h * 0.6);
    let mut out: Vec<Cell> = Vec::new();
    for c in cells {
        let n = (c.w() / med_w).round() as i64;
        if !tall(&c) || c.w() <= med_w * 1.5 || n < 2 || ws.len() < 3 {
            out.push(c);
            continue;
        }
        let count = |x: i64| {
            let (t, b) = rows_of(x);
            (t..=b).filter(|&y| ink.at(x, y)).count()
        };
        let mut from = c.x0;
        for k in 1..n {
            let target = c.x0 + (c.w() * k as f64 / n as f64) as i64;
            let r = (med_w * 0.25) as i64;
            let cut = (target - r..=target + r).min_by_key(|&x| (count(x), (x - target).abs())).unwrap_or(target);
            let mut part = Cell { x0: from, x1: cut - 1, ..c };
            extent(&mut part);
            out.push(part);
            from = cut;
        }
        let mut part = Cell { x0: from, ..c };
        extent(&mut part);
        out.push(part);
    }
    out.retain(|c| c.y1 >= c.y0 && c.x1 >= c.x0);
    for c in &mut out {
        c.kind = classify(ink, band, c);
    }
    // 窄了一点的增时线（青年诗歌 91 末行「3 - - -」每道 10×4 或 10×3、字号 41，不够 0.28 字号）认成了点或认不出：
    // 两个以上紧挨着排开（中间没有别的格、间隔不比自身窄）、各自扁得像增时线（宽过 0.2 字号）的短横是一串增时线——附点是圆的，也不会成串排开
    let flat = |c: &Cell| {
        let rel = ((c.y0 + c.y1) as f64 / 2.0 - band.top(c.cx())) / h;
        matches!(c.kind, CellKind::Dot | CellKind::Other) && c.w() >= h * 0.2 && c.h() <= h * 0.3 && c.w() >= c.h() * DASH_FLAT && rel > 0.25 && rel < 0.8
    };
    let mut i = 0;
    while i < out.len() {
        let mut j = i;
        while j < out.len() && flat(&out[j]) && (j == i || (out[j].x0 - out[j - 1].x1) as f64 >= out[j - 1].w() * 0.8) {
            j += 1;
        }
        if j - i >= 2 {
            for c in &mut out[i..j] {
                c.kind = CellKind::Dash;
            }
        }
        i = j.max(i + 1);
    }
    // 比本行小节线中位宽窄得多（不到四成）、又贴着数字（隔不过 2 像素）的竖条是数字裂出来的碎边（基督更美「1」右边一像素宽的一竖）
    let bw: Vec<f64> = out.iter().filter(|c| matches!(c.kind, CellKind::Bar { .. })).map(|c| c.w()).collect();
    let mb = median(&bw, 0.0);
    for k in 0..out.len() {
        if matches!(out[k].kind, CellKind::Bar { .. }) && bw.len() >= 3 && out[k].w() < mb * 0.4 {
            let touch = |o: &Cell| o.kind == CellKind::Digit && (o.x0 - out[k].x1).max(out[k].x0 - o.x1) <= 2;
            if (k > 0 && touch(&out[k - 1])) || out.get(k + 1).is_some_and(touch) {
                out[k].kind = CellKind::Other;
            }
        }
    }
    // 与本行小节线一般细（不过中位宽的 1.3 倍）、等高、逐行墨宽一致的竖条也是小节线：细线门（0.14 字号）按字号定，线印得粗一点就落成了数字
    //（赞美诗歌 946 第二行末线 6 像素、字号 38）。「1」顶上带旗，那几行比中位宽出一截
    if bw.len() >= 2 {
        for c in out.iter_mut().filter(|c| c.kind == CellKind::Digit && c.h() >= h * 0.9 && c.w() <= mb * 1.3) {
            let ws: Vec<f64> = (c.y0..=c.y1)
                .filter_map(|y| {
                    let a = (c.x0..=c.x1).find(|&x| ink.at(x, y))?;
                    let b = (c.x0..=c.x1).rev().find(|&x| ink.at(x, y))?;
                    Some((b - a + 1) as f64)
                })
                .collect();
            let med = median(&ws, 0.0);
            let max = ws.iter().copied().fold(0.0, f64::max);
            if ws.len() as f64 >= c.h() * 0.95 && max <= med + 1.0 {
                c.kind = CellKind::Bar { thick: false };
            }
        }
        // 声部行之间贯通的小节线只画到下一行的半腰（四声部谱 `5 | 1` 跨两行的线），比数字矮，过不了上面的等高门：
        // 同样细、逐行墨宽一致，又顺着同一列竖直伸出行带半个字号以上的也是小节线——「1」不会伸出自己的行
        for c in out.iter_mut().filter(|c| c.kind == CellKind::Digit && c.h() >= h * 0.5 && c.w() <= mb * 1.3) {
            let ws: Vec<f64> = (c.y0..=c.y1)
                .filter_map(|y| {
                    let a = (c.x0..=c.x1).find(|&x| ink.at(x, y))?;
                    let b = (c.x0..=c.x1).rev().find(|&x| ink.at(x, y))?;
                    Some((b - a + 1) as f64)
                })
                .collect();
            let med = median(&ws, 0.0);
            let max = ws.iter().copied().fold(0.0, f64::max);
            // 伸出行带这条证据够硬，墨宽只挡「1」的旗（宽出半倍以上）：扫描件的线边参差一两像素
            if (ws.len() as f64) < c.h() * 0.95 || max > med * 1.5 + 1.0 {
                continue;
            }
            let reach = |dir: i64| {
                (c.x0..=c.x1)
                    .map(|x| {
                        let mut y = if dir < 0 { c.y0 - 1 } else { c.y1 + 1 };
                        let mut n = 0;
                        while ink.at(x, y) && (n as f64) < h {
                            y += dir;
                            n += 1;
                        }
                        n
                    })
                    .max()
                    .unwrap_or(0) as f64
            };
            if reach(-1).max(reach(1)) >= h * 0.5 {
                c.kind = CellKind::Bar { thick: false };
            }
        }
    }
    // 粗线：比本行细线宽的中位粗一倍以上
    let bw: Vec<f64> = out.iter().filter(|c| matches!(c.kind, CellKind::Bar { .. })).map(|c| c.w()).collect();
    let thin = dolce_omr_core::geom::quantile(&bw, 0.3).max(1.0);
    for c in &mut out {
        if matches!(c.kind, CellKind::Bar { .. }) {
            c.kind = CellKind::Bar { thick: c.w() >= thin * 2.0 && c.w() >= h * 0.1 };
        }
    }
    // 紧挨着粗线的等高细竖条是终止线 / 反复线的那道细线，不是数字「1」
    for i in 0..out.len() {
        let c = out[i];
        if c.kind != CellKind::Digit || c.w() > h * 0.2 || c.h() < h * 0.9 {
            continue;
        }
        let thick_near = |o: &Cell| o.kind == (CellKind::Bar { thick: true }) && ((o.x0 - c.x1).max(c.x0 - o.x1) as f64) <= h * 0.4;
        if (i > 0 && thick_near(&out[i - 1])) || out.get(i + 1).is_some_and(thick_near) {
            out[i].kind = CellKind::Bar { thick: false };
        }
    }
    out
}

/// 一列里穿过带中线的纵向墨段伸出带上沿、下沿各多少（中线上没墨回 None）。
fn overshoot(ink: &Ink, band: &Band, x: i64) -> Option<(f64, f64)> {
    let (t, b) = (band.top(x as f64), band.bottom(x as f64));
    let mid = ((t + b) / 2.0) as i64;
    if !ink.at(x, mid) {
        return None;
    }
    let lim = (band.h() * 1.5) as i64;
    let mut up = mid;
    while mid - up < lim && ink.at(x, up - 1) {
        up -= 1;
    }
    let mut dn = mid;
    while dn - mid < lim && ink.at(x, dn + 1) {
        dn += 1;
    }
    Some((t - up as f64, dn as f64 + 1.0 - b))
}

fn classify(ink: &Ink, band: &Band, c: &Cell) -> CellKind {
    let h = band.h();
    let (cw, ch) = (c.w(), c.h());
    let rel = ((c.y0 + c.y1) as f64 / 2.0 - band.top(c.cx())) / h;
    if ch >= h * 0.9 && cw <= (h * 0.3).max(4.0) {
        // 小节线：纵贯行带、上下都伸出去一截（数字「1」正好与带等高）
        let best = (c.x0..=c.x1).filter_map(|x| overshoot(ink, band, x)).max_by(|a, b| (a.0 + a.1).total_cmp(&(b.0 + b.1)));
        if let Some((up, dn)) = best {
            if (up >= h * 0.07 && dn >= h * 0.07) || up + dn >= h * 0.3 {
                return CellKind::Bar { thick: false };
            }
        }
    }
    // 与数字等高的小节线（数字排版的本子）：细而实心的一根竖条，「1」带旗、带底座，填不满外框
    if ch >= h * 0.9 && cw <= (h * 0.14).max(3.0) && ink.count(&c.rect()) as f64 >= cw * ch * 0.92 {
        return CellKind::Bar { thick: false };
    }
    // 与数字等高的粗线（终止线、反复线的那一道）：把外框填满的实心竖条，数字再粗也有旗、有腰，填不到这么满
    if ch >= h * 0.9 && cw <= h * 0.6 && ink.count(&c.rect()) as f64 >= cw * ch * SOLID {
        return CellKind::Bar { thick: false };
    }
    if ch >= h * 0.72 && cw >= h * 0.1 {
        return CellKind::Digit;
    }
    if ch <= h * 0.3 && cw >= h * 0.28 && cw >= ch * DASH_FLAT && rel > 0.25 && rel < 0.8 {
        return CellKind::Dash;
    }
    if cw <= h * 0.42 {
        // 上下两截墨：冒号
        let mut groups: Vec<(i64, i64)> = Vec::new();
        for y in c.y0..=c.y1 {
            if ink.row_ink(y, c.x0, c.x1 + 1) {
                match groups.last_mut() {
                    Some(g) if g.1 == y - 1 => g.1 = y,
                    _ => groups.push((y, y)),
                }
            }
        }
        if groups.len() == 2 && groups.iter().all(|g| ((g.1 - g.0 + 1) as f64) <= h * 0.32 && ((g.1 - g.0 + 1) as f64) >= h * 0.08) && ch >= h * 0.35 {
            return CellKind::Colon;
        }
        if groups.len() == 1 && ch <= h * 0.42 && ch >= h * 0.08 && cw >= h * 0.08 && rel > 0.3 {
            return CellKind::Dot;
        }
    }
    CellKind::Other
}

/// 多声部：左端一根竖线（连谱号）从上到下括着的几行谱是一个系统。回各行的 (系统号, 系统内第几声部)；没被括着的行为 None。
/// 竖线：比两行谱还高的细长块，在它括着的各行第一个数字的左边。
pub fn systems(ink: &Ink, rows: &[RowFrame]) -> Vec<Option<(u32, u32)>> {
    let mut out: Vec<Option<(u32, u32)>> = vec![None; rows.len()];
    if rows.len() < 2 {
        return out;
    }
    let h = median(&rows.iter().map(|r| r.h()).collect::<Vec<_>>(), 1.0);
    let first_x: Vec<f64> = rows.iter().map(|r| r.digits().map(|c| c.x0).min().unwrap_or(0) as f64).collect();
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let pw = ink.w() as f64;
    // 贴着纸边的（扫描件的黑边）、把整页的行都括进去的不是连谱号
    for k in ink.comps().iter().filter(|k| k.rect.h >= h * 2.2 && k.rect.w <= h * 1.2 && k.rect.x > 2.0 && k.rect.right() < pw - 2.0) {
        let inside: Vec<usize> = (0..rows.len())
            .filter(|&i| {
                let cy = (rows[i].top_at(k.cx) + rows[i].bottom_at(k.cx)) / 2.0;
                // 方括号的钩常收在末行的顶上：行带挨着竖线两端一个字号以内就算括着
                let _ = cy;
                rows[i].bottom_at(k.cx) > k.rect.y - h && rows[i].top_at(k.cx) < k.rect.bottom() + h
            })
            .collect();
        if inside.len() < 2 || (inside.len() == rows.len() && rows.len() >= 5) || inside.iter().any(|&i| k.rect.x > first_x[i]) {
            continue;
        }
        // 同一组行的几根线（连谱号与紧挨着的系统线）只记一次；括得多的盖过括得少的
        if let Some(g) = groups.iter_mut().find(|g| g.iter().any(|i| inside.contains(i))) {
            if inside.len() > g.len() {
                *g = inside;
            }
        } else {
            groups.push(inside);
        }
    }
    groups.sort_by_key(|g| g[0]);
    for (si, g) in groups.iter().enumerate() {
        for (vi, &i) in g.iter().enumerate() {
            out[i] = Some((si as u32, vi as u32));
        }
    }
    out
}

/// 格里逐行墨宽的中位与最宽、有墨的行数（看是不是一根光竖条：「1」顶上的旗那几行宽出一截）。
fn stroke_widths(ink: &Ink, c: &Cell) -> (f64, f64, usize) {
    let ws: Vec<f64> = (c.y0..=c.y1)
        .filter_map(|y| {
            let a = (c.x0..=c.x1).find(|&x| ink.at(x, y))?;
            let b = (c.x0..=c.x1).rev().find(|&x| ink.at(x, y))?;
            Some((b - a + 1) as f64)
        })
        .collect();
    (median(&ws, 0.0), ws.iter().copied().fold(0.0, f64::max), ws.len())
}

/// 小节线多声部互证（同 TS `barline.mutual`）：小节线管一个时间点，同一系统各声部的线横向位置相同。
/// 别的声部有两行以上在这个位置有线时：本行这里读成数字的光竖条（窄、没有旗）改成小节线；本行这里没有格挡着的补一根。
/// 只管行内（首尾两个数字之间）；本行已有的线不少于别的行中位根数的一半（至少两根），夹在连谱号里的歌词行不算声部。
pub fn mutual_bars(ink: &Ink, rows: &mut [RowFrame], sys: &[Option<(u32, u32)>]) {
    let mut groups: std::collections::BTreeMap<u32, Vec<usize>> = std::collections::BTreeMap::new();
    for (i, s) in sys.iter().enumerate() {
        if let Some((g, _)) = s {
            groups.entry(*g).or_default().push(i);
        }
    }
    let bar_xs = |r: &RowFrame| r.bars().map(|c| c.cx()).collect::<Vec<f64>>();
    for idx in groups.values() {
        if idx.len() < 3 {
            continue;
        }
        let xs: Vec<Vec<f64>> = idx.iter().map(|&i| bar_xs(&rows[i])).collect();
        let mut edits: Vec<(usize, Vec<f64>)> = Vec::new();
        for (k, &i) in idx.iter().enumerate() {
            let r = &rows[i];
            let h = r.h();
            let tol = h * 0.4;
            let others = median(&xs.iter().enumerate().filter(|(j, _)| *j != k).map(|(_, v)| v.len() as f64).collect::<Vec<_>>(), 0.0);
            if xs[k].len() < 2 || (xs[k].len() as f64) < others * 0.5 {
                continue;
            }
            let (Some(x0), Some(x1)) = (r.digits().map(|c| c.x0).min(), r.digits().map(|c| c.x1).max()) else { continue };
            let mut seen: Vec<f64> = Vec::new();
            for (j, v) in xs.iter().enumerate() {
                if j == k {
                    continue;
                }
                for &x in v {
                    if seen.iter().any(|t| (t - x).abs() <= tol) {
                        continue;
                    }
                    seen.push(x);
                    if x <= x0 as f64 || x >= x1 as f64 || xs[k].iter().any(|t| (t - x).abs() <= tol) {
                        continue;
                    }
                    let votes = xs.iter().enumerate().filter(|(jj, vv)| *jj != k && vv.iter().any(|t| (t - x).abs() <= tol)).count();
                    if votes >= 2 {
                        edits.push((i, vec![x]));
                    }
                }
            }
        }
        for (i, xs) in edits {
            let r = &mut rows[i];
            let h = r.h();
            for x in xs {
                // 这个位置上的格
                let hit: Vec<usize> = (0..r.cells.len()).filter(|&c| r.cells[c].x0 as f64 - h * 0.1 < x && r.cells[c].x1 as f64 + h * 0.1 > x).collect();
                if hit.is_empty() {
                    let (t, b) = (r.top_at(x).round() as i64, r.bottom_at(x).round() as i64 - 1);
                    let xi = x.round() as i64;
                    let at = r.cells.iter().position(|c| c.x0 > xi).unwrap_or(r.cells.len());
                    r.cells.insert(at, Cell { x0: xi - 1, x1: xi + 1, y0: t, y1: b, kind: CellKind::Bar { thick: false } });
                    continue;
                }
                if let [c] = hit[..] {
                    let cell = r.cells[c];
                    if cell.kind != CellKind::Digit || cell.w() > h * 0.3 || cell.h() < h * 0.5 {
                        continue;
                    }
                    let (med, max, n) = stroke_widths(ink, &cell);
                    if (n as f64) >= cell.h() * 0.95 && max <= med * 1.5 + 1.0 {
                        r.cells[c].kind = CellKind::Bar { thick: false };
                    }
                }
            }
        }
    }
}
