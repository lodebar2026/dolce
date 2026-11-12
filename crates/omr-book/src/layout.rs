//! 单页版面：连通块 → 横向「带」（一行字 / 一行谱及其弧线、八度点），标出页脚、标题候选与谱行。
//! 只看几何，不跑 OCR；页脚与标题候选的真假由 [`crate::scan`] 再拿 OCR 定。对应 web `omr/booksplit/layout.ts`。
use dolce_omr_core::geom::{median, quantile};
use dolce_omr_core::image::{Binary, Rect};
use dolce_omr_core::pixel::ccl::connected_components;
use serde::{Deserialize, Serialize};

/// 一个连通块：外框与质心纵坐标。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Comp {
    pub bbox: Rect,
    pub cy: f64,
}

/// 页面上的一条横向带。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Band {
    pub y0: f64,
    /// 不含：带占 [y0, y1)。
    pub y1: f64,
    pub x0: f64,
    pub x1: f64,
    /// 方正且高 ≥ [`TITLE_H`] × 字高的块数（标题大字）。
    pub tall: usize,
    /// 竖细长、高 ≥ `BAR_H` × 字高的块数（小节线；大字带里不算整个落在大字那一排以内的）。
    pub bars: usize,
    /// 全是扁块（弧线、减时线）。
    pub flat: bool,
    /// 方正块（字）的中位高；没有为 0。
    pub sq_h: f64,
    /// 大字块的中位高；没有为 0。
    pub big_h: f64,
    /// 带内各块的包围盒（扫描完即清空省内存）。
    #[serde(skip)]
    pub boxes: Vec<Rect>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PageLayout {
    pub w: f64,
    pub h: f64,
    /// 本页正文字高（数字、歌词字的中位高）。
    pub char_h: f64,
    /// 本页字行（非谱行、非大字行）的字高：各字行方正块中位高的 0.9 分位。有的本子一页里某首的歌词字比别的大，
    /// 标题要比最大的那种字行还大才算。
    pub text_h: f64,
    /// 铺开的大字歌词行的大字中位高；没有这种行为 0。没读出调号的标题字要比它大（简线混排谱的歌词比数字大一圈）。
    pub lyric_h: f64,
    pub bands: Vec<Band>,
    /// 纸色（背景像素的中位 RGB）。
    pub paper: [u8; 3],
}

/// 标题大字：方正块高 ≥ 字高 × 此值。
pub const TITLE_H: f64 = 1.22;
/// 小节线：竖细块高 ≥ 字高 × 此值。
const BAR_H: f64 = 1.15;
/// 没有小节线的标题候选带最高几个字高（标题旁的作者、出处常排两行）
const TITLE_BAND_H: f64 = 4.5;
/// 标题带里像小节线的笔画最多几道
const TITLE_STROKES: usize = 2;
/// 歌词行：大字行铺开占版心宽的这么多，一页至少几行
const LYRIC_SPAN: f64 = 0.6;
const LYRIC_ROWS: usize = 3;
/// 上下两块间隙 ≤ 字高 × 此值就并进同一带（谱行与其弧线、八度点隔得很近）。
const MERGE_GAP: f64 = 0.12;

/// 一页的显著连通块（去掉碰纸边的与斑点）与正文字高。
pub struct PageComps {
    pub w: f64,
    pub h: f64,
    pub char_h: f64,
    pub comps: Vec<Comp>,
}

pub fn page_comps(bin: &Binary) -> PageComps {
    let (w, h) = (bin.w as f64, bin.h as f64);
    let mut labels = vec![0i32; bin.w * bin.h];
    let flat = connected_components(&bin.data, bin.w, bin.h, 4.0, &mut labels);
    drop(labels);
    let all: Vec<Comp> = flat
        .chunks_exact(8)
        .map(|c| Comp { bbox: Rect::new(c[1], c[2], c[3], c[4]), cy: c[7] })
        .filter(|c| !touches_edge(&c.bbox, w, h))
        .collect();
    let char_h = estimate_char_h(&all, h);
    PageComps { w, h, char_h, comps: all.into_iter().filter(|c| significant(&c.bbox, char_h)).collect() }
}

/// 版面：`drop` 里的块（已认出的页码，按下标）不进带。`rgb` 只用来取纸色（灰度页给空）。
pub fn analyze_page(pc: &PageComps, bin: &Binary, gray: &[u8], rgb: &[u8], drop: &[usize]) -> PageLayout {
    let char_h = pc.char_h;
    let comps: Vec<Comp> = pc.comps.iter().enumerate().filter(|(i, _)| !drop.contains(i)).map(|(_, c)| *c).collect();
    // 孤立的小污点自成一带（矮于半个字高、窄于一个字宽）：不算内容，否则会顶替页脚成为「最下一带」、还把空白拼进曲子
    let bands: Vec<Band> = build_bands(&comps, char_h).into_iter().filter(|b| b.y1 - b.y0 >= char_h * 0.45 || b.x1 - b.x0 >= char_h).collect();
    let text_hs: Vec<f64> = bands.iter().filter(|b| b.bars == 0 && !b.flat && b.sq_h > 0.0 && b.tall < 2).map(|b| b.sq_h).collect();
    let text_h = char_h.max(if text_hs.is_empty() { 0.0 } else { quantile(&text_hs, 0.9) });
    // 歌词字比数字大一圈的本子（简线混排谱的歌词行）：铺满版心六成以上宽的大字带有 LYRIC_ROWS 条以上时，取它们大字高的中位作歌词字高
    let x0 = bands.iter().map(|b| b.x0).fold(f64::INFINITY, f64::min);
    let x1 = bands.iter().map(|b| b.x1).fold(f64::NEG_INFINITY, f64::max);
    let wide: Vec<f64> = bands.iter().filter(|b| b.tall >= 2 && b.big_h > 0.0 && b.x1 - b.x0 >= (x1 - x0) * LYRIC_SPAN).map(|b| b.big_h).collect();
    let lyric_h = if wide.len() >= LYRIC_ROWS { median(&wide, 0.0) } else { 0.0 };
    PageLayout { w: pc.w, h: pc.h, char_h, text_h, lyric_h, bands, paper: paper_color(bin, gray, rgb) }
}

/// 页码候选：页面下 25% 里的「词」（同排、横向间隙 ≤ 1 字高的块并成一词），要
/// 不高（≤ 1.8 字高）、不宽（≤ 7 字高）、有够高的块、同排左右 2.5 字高内没有别的块（页码常与末行歌词同排、在最右）、
/// 下面没有内容（矮于 0.6 字高的污点不算）。最靠下的排前。交出各词的块下标。真假由逐字认数定。
pub fn footer_words(pc: &PageComps) -> Vec<Vec<usize>> {
    let (h, ch) = (pc.h, pc.char_h);
    let mut low: Vec<usize> = (0..pc.comps.len()).filter(|&i| pc.comps[i].bbox.y >= h * 0.75).collect();
    low.sort_by(|&a, &b| pc.comps[a].bbox.x.total_cmp(&pc.comps[b].bbox.x));
    // 按整词外框判同排；再把上下只差几个像素、合起来仍是页码大小的两词并上
    let mut words: Vec<(Vec<usize>, Rect)> = Vec::new();
    for &i in &low {
        let c = &pc.comps[i].bbox;
        if let Some(w) = words.iter_mut().find(|(_, b)| c.y < b.bottom() && c.bottom() > b.y && c.x - b.right() <= ch) {
            w.0.push(i);
            w.1 = box_of(pc, &w.0);
        } else {
            words.push((vec![i], *c));
        }
    }
    let mut merged = true;
    while merged {
        merged = false;
        'outer: for a in 0..words.len() {
            for b in a + 1..words.len() {
                let (aa, bb) = (&words[a].1, &words[b].1);
                let gx = aa.x.max(bb.x) - aa.right().min(bb.right());
                let gy = aa.y.max(bb.y) - aa.bottom().min(bb.bottom());
                if gx > ch || gy > ch * 0.2 {
                    continue;
                }
                let g: Vec<usize> = words[a].0.iter().chain(&words[b].0).copied().collect();
                let bx = box_of(pc, &g);
                if bx.h > ch * 1.8 || bx.w > ch * 7.0 {
                    continue;
                }
                words[a] = (g, bx);
                words.remove(b);
                merged = true;
                break 'outer;
            }
        }
    }
    let mut out: Vec<(Vec<usize>, Rect)> = Vec::new();
    for (g, bx) in words {
        if bx.h > ch * 1.8 || bx.w > ch * 7.0 {
            continue;
        }
        if !g.iter().any(|&i| pc.comps[i].bbox.h >= ch * 0.6) {
            continue;
        }
        let others = (0..pc.comps.len()).filter(|i| !g.contains(i)).map(|i| &pc.comps[i].bbox);
        let (mut side_by, mut below) = (false, false);
        for c in others {
            if overlaps_y(c, &bx) && (bx.x - c.right()).max(c.x - bx.right()) < ch * 2.5 {
                side_by = true;
            }
            if c.y >= bx.bottom() && (c.h >= ch * 0.6 || c.w >= ch) {
                below = true;
            }
        }
        if !side_by && !below {
            out.push((g, bx));
        }
    }
    out.sort_by(|a, b| b.1.bottom().total_cmp(&a.1.bottom()));
    out.into_iter().map(|o| o.0).collect()
}

fn overlaps_y(a: &Rect, b: &Rect) -> bool {
    a.bottom().min(b.bottom()) - a.y.max(b.y) > a.h.min(b.h) * 0.3
}

/// 几块的合并外框（块下标）。
pub fn box_of(pc: &PageComps, g: &[usize]) -> Rect {
    rects_box(g.iter().map(|&i| pc.comps[i].bbox))
}

pub fn rects_box(rs: impl IntoIterator<Item = Rect>) -> Rect {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for b in rs {
        x0 = x0.min(b.x);
        y0 = y0.min(b.y);
        x1 = x1.max(b.right());
        y1 = y1.max(b.bottom());
    }
    Rect::new(x0, y0, x1 - x0, y1 - y0)
}

fn touches_edge(b: &Rect, w: f64, h: f64) -> bool {
    b.x <= 0.0 || b.y <= 0.0 || b.right() >= w || b.bottom() >= h
}

/// 正文字高：页高 0.8%–4% 之间、宽高比不离谱的块的中位高（汉字偏旁拆散也大体落在一个字高附近）。
fn estimate_char_h(comps: &[Comp], h: f64) -> f64 {
    let hs: Vec<f64> = comps
        .iter()
        .map(|c| c.bbox)
        .filter(|b| b.h >= h * 0.008 && b.h <= h * 0.04 && b.w >= b.h * 0.5 && b.w <= b.h * 2.0)
        .map(|b| b.h)
        .collect();
    median(&hs, h * 0.018)
}

/// 不是斑点：高或宽有字高的三成（细竖的小节线、扁长的减时线与弧线都算）。
fn significant(b: &Rect, char_h: f64) -> bool {
    b.w.max(b.h) >= char_h * 0.3 && b.w.min(b.h) >= 2.0
}

fn is_tall(b: &Rect, ch: f64) -> bool {
    b.h >= ch * TITLE_H && b.w >= b.h * 0.4 && b.w <= b.h * 2.5
}

fn is_bar(b: &Rect, ch: f64) -> bool {
    b.h >= ch * BAR_H && b.w <= b.h * 0.12
}

fn build_bands(comps: &[Comp], ch: f64) -> Vec<Band> {
    let mut sorted: Vec<Comp> = comps.to_vec();
    sorted.sort_by(|a, b| a.bbox.y.total_cmp(&b.bbox.y));
    let gap = (ch * MERGE_GAP).max(2.0);
    let mut groups: Vec<Vec<Comp>> = Vec::new();
    let mut bottom = f64::NEG_INFINITY;
    for c in sorted {
        if groups.is_empty() || c.bbox.y > bottom + gap {
            bottom = c.bbox.bottom();
            groups.push(vec![c]);
        } else {
            bottom = bottom.max(c.bbox.bottom());
            groups.last_mut().unwrap().push(c);
        }
    }
    groups.into_iter().flat_map(|g| split_title(g, ch)).map(|g| band_of(&g, ch)).collect()
}

fn band_of(g: &[Comp], ch: f64) -> Band {
    let (mut y0, mut y1, mut x0, mut x1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    let (mut tall, mut bars, mut flat) = (0usize, 0usize, true);
    let (mut sq, mut big) = (Vec::new(), Vec::new());
    for c in g {
        let b = &c.bbox;
        y0 = y0.min(b.y);
        y1 = y1.max(b.bottom());
        x0 = x0.min(b.x);
        x1 = x1.max(b.right());
        if is_tall(b, ch) {
            tall += 1;
            big.push(b.h);
        }
        if is_bar(b, ch) {
            bars += 1;
        }
        if !(b.w >= b.h * 1.8 && b.h < ch * 0.7) {
            flat = false;
        }
        if b.h >= ch * 0.6 && b.w >= b.h * 0.6 && b.w <= b.h * 1.6 {
            sq.push(b.h);
        }
    }
    // 大字带里整个落在大字那一排高度以内的竖细块是字的笔画（「惧」的竖心旁）或细体数字「1」（曲号「170」），不是小节线。
    // 标题里这种块最多一两个；带大字的谱行（「和：」）小节线有好几道，也都落在那一排里，不折算
    if tall >= 2 && bars <= TITLE_STROKES {
        let tb = g.iter().filter(|c| is_tall(&c.bbox, ch));
        let t0 = tb.clone().map(|c| c.bbox.y).fold(f64::INFINITY, f64::min) - ch * 0.2;
        let t1 = tb.map(|c| c.bbox.bottom()).fold(f64::NEG_INFINITY, f64::max) + ch * 0.2;
        bars = g.iter().filter(|c| is_bar(&c.bbox, ch) && (c.bbox.y < t0 || c.bbox.bottom() > t1)).count();
    }
    Band { y0, y1, x0, x1, tall, bars, flat, sq_h: median(&sq, 0.0), big_h: median(&big, 0.0), boxes: g.iter().map(|c| c.bbox).collect() }
}

/// 标题行与下面的谱行粘成一带（谱行上的升降号、弧线顶到了标题行底）、或与下面几行页眉粘成一带时，在标题大字的底边处切开。
/// 只看最上面一排大字，且小节线的中心全在它底边之下才切，免得把谱行里「和：」这类大字当标题行切出去。
fn split_title(g: Vec<Comp>, ch: f64) -> Vec<Vec<Comp>> {
    let tall: Vec<&Comp> = g.iter().filter(|c| is_tall(&c.bbox, ch)).collect();
    if tall.len() < 2 {
        return vec![g];
    }
    // 只看最上面一排大字（谱行里连着减时线的数字也够「大」，不能算进标题行）
    let top0 = tall.iter().map(|c| c.bbox.y).fold(f64::INFINITY, f64::min);
    let row: Vec<&&Comp> = tall.iter().filter(|c| c.bbox.y <= top0 + ch * 0.6).collect();
    if row.len() < 2 {
        return vec![g];
    }
    let ty1 = row.iter().map(|c| c.bbox.bottom()).fold(f64::NEG_INFINITY, f64::max);
    // 整个落在大字那一排里的「小节线」是曲号里笔画细的「1」（「139」），不算
    let low_bars: Vec<&Comp> = g.iter().filter(|c| is_bar(&c.bbox, ch) && (c.bbox.y < top0 - ch * 0.2 || c.bbox.bottom() > ty1 + ch * 0.2)).collect();
    // 没有小节线：标题行与下面几行页眉（出处、调号、速度）挨得紧粘成了一带——有块整个落在大字底边以下才切
    if low_bars.is_empty() && !g.iter().any(|c| c.bbox.y >= ty1) {
        return vec![g];
    }
    if !low_bars.is_empty() && low_bars.iter().map(|c| c.cy).fold(f64::INFINITY, f64::min) < ty1 {
        return vec![g]; // 小节线顶可能挨上标题底，按中心比
    }
    let (top, rest): (Vec<Comp>, Vec<Comp>) = g.iter().partition(|c| c.cy <= ty1);
    if !top.is_empty() && !rest.is_empty() {
        vec![top, rest]
    } else {
        vec![g]
    }
}

/// 纸色：背景像素（隔点抽样）各通道中位数。灰度页三个通道同取灰度。
fn paper_color(bin: &Binary, gray: &[u8], rgb: &[u8]) -> [u8; 3] {
    let (mut r, mut g, mut b) = (Vec::new(), Vec::new(), Vec::new());
    let step = (((bin.w * bin.h) as f64 / 40000.0).sqrt().floor() as usize).max(1);
    for y in (0..bin.h).step_by(step) {
        for x in (0..bin.w).step_by(step) {
            let i = y * bin.w + x;
            if bin.data[i] != 0 {
                continue;
            }
            if rgb.is_empty() {
                let v = gray[i] as f64;
                r.push(v);
                g.push(v);
                b.push(v);
            } else {
                r.push(rgb[i * 3] as f64);
                g.push(rgb[i * 3 + 1] as f64);
                b.push(rgb[i * 3 + 2] as f64);
            }
        }
    }
    let m = |v: &[f64]| median(v, 255.0).round() as u8;
    [m(&r), m(&g), m(&b)]
}

/// 标题候选：有 ≥ 2 个大字、不是谱行（标题带里小节线极少）、不太高（字行粘上谱行的那种带里
/// 连着减时线的数字也够「大」，双减时线还会被 OCR 读成「=」冒充调号）。字是否比本页字行大由 OCR 那步再看。
pub fn is_title_candidate(b: &Band, p: &PageLayout) -> bool {
    // 没有小节线的带可以高些：标题旁的作者、出处常排两行
    b.tall >= 2 && b.bars <= 1 && b.y1 - b.y0 <= p.char_h * if b.bars > 0 { 3.0 } else { TITLE_BAND_H }
}

/// 谱行：有小节线。
pub fn is_music_band(b: &Band) -> bool {
    b.bars >= 1 && b.tall < 2
}
