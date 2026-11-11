//! JM1 框架结构：数字高、数字行（等高数字成排）、行带（上下沿随 x 的直线）、带内切格（数字 / 小节线 / 增时线 / 点）。
//!
//! 行带之内只有音符本体：八度点、弧在带上方，减时线、低音点、歌词在带下方。带内逐列看有没有墨切成格，
//! 所以数字与上下的线、点、弧粘成一块连通块也不要紧——认数字不靠连通块外框。
use crate::prep::{Comp, Ink};
use dolce_omr_core::geom::median;
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::surface::{blit, Gray};

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
    let src = Gray::crop_binary(&ink.bin, *r, 0);
    let (w, h) = (src.w as f64, src.h as f64);
    let s = (48.0 / w).min(48.0 / h);
    let mut out = Gray::new(64, 64, 255);
    blit(&mut out, &src, Rect::new(0.0, 0.0, w, h), Rect::new((64.0 - w * s) / 2.0, (64.0 - h * s) / 2.0, w * s, h * s));
    out
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

/// 整格只读出一个 0–7。
fn strict_digit(t: &str) -> Option<u8> {
    let t = t.trim();
    t.chars().next().filter(|c| ('0'..='7').contains(c) && t.chars().count() == 1).map(|c| c as u8 - b'0')
}

/// 找数字行。数字样的连通块（瘦高、与字号等高）按纵向中心聚成排，一排里多数读得出数字的是谱行的种子；
/// 由种子定行带，再在带内切格。只有两三个数字又没有小节线的排（曲号、拍号）不算。
pub fn find_rows(ink: &Ink, num_h: f64, ocr: &CachedOcr) -> Vec<RowFrame> {
    let cand: Vec<&Comp> = ink
        .comps
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
    for l in lines {
        let digits: Vec<Rect> = l.iter().filter(|&&i| read[i].is_some()).map(|&i| cand[i].rect).collect();
        if std::env::var("OMR_JP_DEBUG").is_ok() && l.len() >= 3 {
            eprintln!("排 y{:.0} 块{} 读出数字{}", cand[l[0]].rect.cy(), l.len(), digits.len());
        }
        if digits.is_empty() || (digits.len() as f64) < l.len() as f64 * 0.5 {
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
        let row = RowFrame { band, cells: cut_cells(ink, &band) };
        let nd = row.digits().count();
        let nb = row.bars().count();
        // 带内切出的数字格多数得真读得出数字（歌词行里夹着段号、汉字的竖笔伸出带外像小节线）
        let imgs: Vec<Gray> = row.digits().map(|c| digit_cell(ink, &c.rect())).collect();
        let good = ocr.read_cells(&imgs).map_or(0, |v| v.iter().filter(|t| strict_digit(t).is_some()).count());
        if std::env::var("OMR_JP_DEBUG").is_ok() {
            eprintln!("  带 y{:.0} 高{:.0} 数字格{nd} 读出{good} 线{nb}", band.top0, band.h());
        }
        if (good as f64) < nd as f64 * 0.6 {
            continue;
        }
        let span = row.digits().map(|c| c.x1).max().unwrap_or(0) - row.digits().map(|c| c.x0).min().unwrap_or(0);
        if nd >= 1 && (nb >= 1 || (nd >= 4 && span as f64 >= ink.bin.w as f64 * 0.3)) {
            rows.push(row);
        }
    }
    rows.sort_by(|a, b| a.band.top0.total_cmp(&b.band.top0));
    rows
}

/// 带内切格并分类。
fn cut_cells(ink: &Ink, band: &Band) -> Vec<Cell> {
    let w = ink.bin.w as i64;
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
    let ws: Vec<f64> = cells.iter().filter(|c| tall(c) && c.w() >= c.h() * 0.4 && c.w() <= c.h() * 0.9).map(|c| c.w()).collect();
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
    // 粗线：比本行细线宽的中位粗一倍以上
    let bw: Vec<f64> = out.iter().filter(|c| matches!(c.kind, CellKind::Bar { .. })).map(|c| c.w()).collect();
    let thin = dolce_omr_core::geom::quantile(&bw, 0.3).max(1.0);
    for c in &mut out {
        if matches!(c.kind, CellKind::Bar { .. }) {
            c.kind = CellKind::Bar { thick: c.w() >= thin * 2.0 && c.w() >= h * 0.1 };
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
    if ch >= h * 0.72 && cw >= h * 0.1 {
        return CellKind::Digit;
    }
    if ch <= h * 0.3 && cw >= h * 0.28 && cw >= ch * 1.8 && rel > 0.25 && rel < 0.8 {
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
    let pw = ink.bin.w as f64;
    // 贴着纸边的（扫描件的黑边）、把整页的行都括进去的不是连谱号
    for k in ink.comps.iter().filter(|k| k.rect.h >= h * 2.2 && k.rect.w <= h * 1.2 && k.rect.x > 2.0 && k.rect.right() < pw - 2.0) {
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
