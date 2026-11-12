//! 第一遍逐页扫描：版面几何 + 页脚页码 OCR + 标题候选 OCR + 像目录的页整页 OCR。只留几何与文字，不留像素。
//! 对应 web `omr/booksplit/scan.ts`。
use crate::layout::{analyze_page, box_of, footer_words, is_music_band, is_title_candidate, page_comps, rects_box, Band, PageComps, PageLayout};
use crate::ocr::{numerals, region, reread, OcrLine};
use crate::source::PageImage;
use dolce_omr_core::geom::overlap1d;
use dolce_omr_core::image::{Binary, Rect};
use dolce_omr_core::pixel::preprocess::{otsu, sauvola_multi, to_gray};
use dolce_omr_ocr::cache::CachedOcr;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// 一页上认出的标题。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TitleHit {
    /// 标题所在的带（`PageInfo::layout.bands` 的下标）。
    pub band: usize,
    /// 曲名（OCR，去字间空格）；没认出为空串。
    pub title: String,
    /// 标题行上印的曲号。
    pub number: Option<u32>,
    /// 整行 OCR 里曲号首末两字的横坐标（逐字重认用）。
    #[serde(skip)]
    pub number_span: Option<(f64, f64)>,
    /// 曲名由几框拼成时的整段外框（整段重认用）。
    #[serde(skip)]
    pub title_box: Option<Rect>,
}

/// 目录条目。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TocEntry {
    /// 首句 / 经文等（只作报告用）。
    pub text: String,
    pub number: u32,
    /// 印的页码；只列「曲号 曲名」的目录没有。
    pub page: Option<u32>,
}

/// 页脚的一个读得出数的候选：数、块（下标）、墨迹框。
#[derive(Clone, Debug)]
pub struct FooterCand {
    pub n: u32,
    pub comps: Vec<usize>,
    pub bbox: Rect,
}

/// 第一遍扫描每页得到的信息（不留像素）。
#[derive(Clone, Debug)]
pub struct PageInfo {
    pub index: usize,
    /// 版面；`layout.bands` 即正文带（已去页脚）。
    pub layout: PageLayout,
    /// 印的页码（页脚 OCR）。
    pub printed: Option<u32>,
    /// 页码的墨迹框（已从正文剔除；与正文同排时输出图上要涂掉）。
    pub footer: Option<Rect>,
    /// 页脚里读得出数的全部候选（最靠下的在前）；顺序校页码时按「上一页 + 1」从里面挑。
    pub footer_cands: Vec<FooterCand>,
    pub titles: Vec<TitleHit>,
    /// 整页 OCR 出的目录条目（只对像目录的页做）。
    pub toc: Vec<TocEntry>,
}

impl PageInfo {
    pub fn body(&self) -> &[Band] {
        &self.layout.bands
    }
}

static PAGE_NO_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-–—_~·.\s]*([0-9]{1,4})[-–—_~·.\s]*$").unwrap());
/// 调号「1=C」「1=♭E」：标题行的标志（调名字母常读错，只认「1=」）。
static KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"1\s*[=＝]").unwrap());
static CJK_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x{3400}-\x{9fff}\x{f900}-\x{faff}·、，！？]+").unwrap());
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[0-9]+").unwrap());

/// 汉字（含扩展 A 与兼容区）。
pub fn is_cjk(c: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&c) || ('\u{f900}'..='\u{faff}').contains(&c)
}
fn has_cjk(s: &str) -> bool {
    s.chars().any(is_cjk)
}

/// 页面二值图：Sauvola（灰度与 R、G、B 里 Otsu 分得最开的那个通道）的墨再与亮度的全局 Otsu 阈值取交。
/// 扫描页常有背面透印的淡灰字，Sauvola 是局部阈值，在透印处照样判成墨，把相邻两带粘成一片；透印比正面墨浅得多，全局阈值一卡就掉。
pub fn page_binary(img: &PageImage) -> Binary {
    let (w, h) = (img.w, img.h);
    let n = w * h;
    let luma = if img.rgb.is_empty() { img.gray.clone() } else { to_gray(&img.rgb, w, h, 3) };
    let mut best = luma.clone();
    if !img.rgb.is_empty() {
        let mut best_sep = otsu(&luma).1;
        for c in 0..3 {
            let ch: Vec<u8> = (0..n).map(|i| img.rgb[i * 3 + c]).collect();
            let sep = otsu(&ch).1;
            if sep > best_sep {
                best_sep = sep;
                best = ch;
            }
        }
    }
    // 窗口约取图像短边的 1/30（取奇数），覆盖一个字号又不至于退化成全局阈值
    let win = 15usize.max(((w.min(h) as f64 / 30.0).round() as usize) | 1);
    let mut data = vec![0u8; n];
    sauvola_multi(&best, w, h, win >> 1, &[0.2], &mut data);
    let (thr, _) = otsu(&luma);
    for (d, &g) in data.iter_mut().zip(&luma) {
        if g > thr {
            *d = 0;
        }
    }
    Binary { w, h, data }
}

/// 一页的二值图与连通块，加页脚候选（逐个读过数）。重扫换页码时复用。
pub struct Prepared {
    pub bin: Binary,
    pub pc: PageComps,
    pub footers: Vec<FooterCand>,
}

pub fn prepare(img: &PageImage, ocr: &CachedOcr) -> Prepared {
    let bin = page_binary(img);
    let pc = page_comps(&bin);
    // 页码先在连通块上找出来剔掉，再分带：页码常紧贴末行、甚至与末行歌词同排，按带找会被并进正文
    let footers = footer_words(&pc)
        .into_iter()
        .filter_map(|g| read_page_number(&bin, &g, &pc, ocr).map(|n| FooterCand { n, bbox: box_of(&pc, &g), comps: g }))
        .collect();
    Prepared { bin, pc, footers }
}

/// 扫一页。`footer`：取第几个页脚候选（None = 不认页码）；`toc`：Some(true) 当目录页整页 OCR、Some(false) 不当、None 按版面自动认。
pub fn scan_page(index: usize, img: &PageImage, p: &Prepared, ocr: &CachedOcr, footer: Option<usize>, toc: Option<bool>) -> PageInfo {
    let (bin, pc) = (&p.bin, &p.pc);
    let f = footer.and_then(|k| p.footers.get(k));
    let drop: &[usize] = f.map_or(&[], |f| &f.comps);
    let layout = analyze_page(pc, bin, &img.gray, &img.rgb, drop);
    let mut info = PageInfo { index, layout, printed: f.map(|f| f.n), footer: f.map(|f| f.bbox), footer_cands: p.footers.clone(), titles: Vec::new(), toc: Vec::new() };
    let lay = &info.layout;

    // 刚认出标题、还没到谱行（两道小节线以上的带）：这一段是本首的页眉，里面的大字（出处「希伯来书13:1-2节」与调号同排）不是下一首的标题
    let mut in_header = false;
    for k in 0..lay.bands.len() {
        let b = &lay.bands[k];
        if b.bars >= 2 {
            in_header = false;
        }
        if in_header || !is_title_candidate(b, lay) {
            continue;
        }
        let lines = region(ocr, bin, &pad(b, lay, lay.char_h * 0.3));
        let ink_h = |r: &Rect| ink_height(bin, r);
        let mut hit = parse_title(&lines, k, b, lay, &ink_h, false);
        // 调号不与曲名同排、印在下面的页眉行里（简线混排谱：曲名、出处、「1=F 4/4」各占一行）：往下到谱行之前找调号
        if hit.is_none() && lines.iter().any(|l| has_cjk(&l.text)) && key_below(bin, &lay.bands, k, lay, ocr) {
            hit = parse_title(&lines, k, b, lay, &ink_h, true);
        }
        if std::env::var("OMR_BOOK_DEBUG").ok().and_then(|v| v.parse::<usize>().ok()) == Some(index) {
            for l in &lines {
                eprintln!("[{index}] 带{k} {:?} {:?} {:?}", l.text, l.bbox, l.chars.iter().map(|c| (c.text.as_str(), c.cx.round())).collect::<Vec<_>>());
            }
            eprintln!("[{index}] 带{k} → {:?}", hit.as_ref().map(|h| (&h.title, h.number, h.title_box)));
        }
        let Some(mut hit) = hit else { continue };
        in_header = true;
        if let Some(tb) = hit.title_box {
            if let Some(t) = reread_title(bin, &tb, ocr) {
                if std::env::var("OMR_BOOK_DEBUG").ok().and_then(|v| v.parse::<usize>().ok()) == Some(index) {
                    eprintln!("[{index}] 重读 {t:?}");
                }
                // 重读只留汉字：读出的字与原曲名一样时留原曲名（带着「神啊，愿列邦称赞祢」的逗号）
                let han: String = hit.title.chars().filter(|&c| is_cjk(c)).collect();
                if t != han && t.chars().count() >= han.chars().count() {
                    hit.title = t;
                }
            }
        }
        // 曲号以带两端的数字块逐字认为准（整行 OCR 常把曲号与调号读成一串「1151=C」、或把粗体数字读错）
        if let Some(n) = edge_number(bin, b, lay.char_h, ocr, hit.number_span) {
            hit.number = Some(n);
        }
        info.titles.push(hit);
    }

    if toc.unwrap_or_else(|| looks_like_toc(&info.layout.bands, info.layout.h)) {
        info.toc = parse_toc(&region(ocr, bin, &Rect::new(0.0, 0.0, bin.w as f64, bin.h as f64)));
    }
    for b in &mut info.layout.bands {
        b.boxes = Vec::new();
    }
    info
}

/// 页眉行最多看几带
const HEADER_BANDS: usize = 3;

/// 第 k 带（标题候选）之下、谱行与下一个（读不出调号的）标题候选之前的几带里读得出调号「1=」。
fn key_below(bin: &Binary, body: &[Band], k: usize, p: &PageLayout, ocr: &CachedOcr) -> bool {
    for b in body.iter().take(k + HEADER_BANDS + 1).skip(k + 1) {
        if b.bars >= 2 {
            return false;
        }
        let lines = region(ocr, bin, &pad(b, p, p.char_h * 0.3));
        if reads_key(&lines) {
            return true;
        }
        // 读不出调号的下一个标题候选就是下一首了（调号与出处同排的页眉行也像候选，先读再停）
        if is_title_candidate(b, p) {
            return false;
        }
    }
    false
}

/// 横向重叠的框并成一个（断笔的字是上下几截）；输入按 x 排好。
fn merge_overlapping(rs: impl IntoIterator<Item = Rect>) -> Vec<Rect> {
    let mut cells: Vec<Rect> = Vec::new();
    for r in rs {
        match cells.last_mut() {
            Some(last) if r.x < last.right() => *last = rects_box([*last, r]),
            _ => cells.push(r),
        }
    }
    cells
}

/// 曲号按字形逐字认：带内块按横向间隙 ≤ 0.7 字高并成「词」，看最左、最右两个词——整词的字（块按横向重叠并成字）
/// 全像数字（够高、不宽）且不超过 4 个，才逐字按 0–9 认。「1=C」里有「=」、出处「1-5」里有「-」，整词就不算。
/// 两端都像曲号时取离整行 OCR 读到曲号的位置近的那个，没读到取左边。
fn edge_number(bin: &Binary, b: &Band, ch: f64, ocr: &CachedOcr, span: Option<(f64, f64)>) -> Option<u32> {
    if b.boxes.is_empty() {
        return None;
    }
    let mut boxes = b.boxes.clone();
    boxes.sort_by(|p, q| p.x.total_cmp(&q.x));
    let mut words: Vec<Vec<Rect>> = Vec::new();
    for r in boxes {
        match words.last_mut() {
            Some(w) if r.x - w.iter().map(|q| q.right()).fold(f64::NEG_INFINITY, f64::max) <= ch * 0.7 => w.push(r),
            _ => words.push(vec![r]),
        }
    }
    let ends: Vec<&Vec<Rect>> = if words.len() > 1 { vec![&words[0], &words[words.len() - 1]] } else { words.iter().collect() };
    let mut cands: Vec<(u32, f64)> = Vec::new();
    for w in ends {
        let cells = merge_overlapping(w.iter().copied());
        if cells.is_empty() || cells.len() > 4 {
            continue;
        }
        if !cells.iter().all(|c| c.h >= ch * 0.8 && c.h <= ch * 2.0 && c.w <= c.h * 0.9) {
            continue;
        }
        let ds = numerals(ocr, bin, &cells);
        if ds.iter().all(Option::is_some) && ds[0] != Some(0) {
            let n = ds.iter().fold(0u32, |a, d| a * 10 + d.unwrap());
            cands.push((n, cells[0].x));
        }
    }
    match span {
        Some((s0, _)) if cands.len() >= 2 => cands.iter().copied().reduce(|a, c| if (c.1 - s0).abs() < (a.1 - s0).abs() { c } else { a }).map(|c| c.0),
        _ => cands.first().map(|c| c.0),
    }
}

/// 页码：词里的块按横向重叠并成字（断笔并回），够高的逐字按 0–9 认（「– 4 –」这种整片检测常读丢）；
/// 有字认不出、或两字粘成一块时退整片 OCR。None = 不是页码。
fn read_page_number(bin: &Binary, g: &[usize], pc: &PageComps, ocr: &CachedOcr) -> Option<u32> {
    let mut rs: Vec<Rect> = g.iter().map(|&i| pc.comps[i].bbox).collect();
    rs.sort_by(|a, b| a.x.total_cmp(&b.x));
    let cells: Vec<Rect> = merge_overlapping(rs).into_iter().filter(|r| r.h >= pc.char_h * 0.6).collect();
    if cells.is_empty() || cells.len() > 4 {
        return None;
    }
    // 两个数字粘成一块（「44」）逐字认不了，交给整片 OCR
    if cells.iter().all(|c| c.w <= c.h * 0.95) {
        let ds = numerals(ocr, bin, &cells);
        if ds.iter().all(Option::is_some) {
            return Some(ds.iter().fold(0u32, |a, d| a * 10 + d.unwrap()));
        }
    }
    let b = box_of(pc, g);
    let d = (pc.char_h * 0.4).round();
    let (x, y) = ((b.x - d).max(0.0), (b.y - d).max(0.0));
    let r = Rect::new(x, y, pc.w.min(b.right() + d) - x, pc.h.min(b.bottom() + d) - y);
    let text: String = region(ocr, bin, &r).iter().map(|l| l.text.as_str()).collect();
    PAGE_NO_RE.captures(&text).and_then(|m| m[1].parse().ok())
}

/// 框里墨迹的纵向实高（有 ≥ 2 个墨点的首行到末行）。
fn ink_height(bin: &Binary, r: &Rect) -> f64 {
    let (mut y0, mut y1) = (-1i64, -1i64);
    let x0 = r.x.round().max(0.0) as usize;
    let x1 = (r.right().round().max(0.0) as usize).min(bin.w);
    let ya = r.y.round().max(0.0) as usize;
    let yb = (r.bottom().round().max(0.0) as usize).min(bin.h);
    for y in ya..yb {
        let row = &bin.data[y * bin.w..(y + 1) * bin.w];
        if x1 > x0 && row[x0..x1].iter().filter(|&&v| v != 0).take(2).count() >= 2 {
            if y0 < 0 {
                y0 = y as i64;
            }
            y1 = y as i64;
        }
    }
    if y0 < 0 {
        0.0
    } else {
        (y1 - y0 + 1) as f64
    }
}

fn pad(b: &Band, p: &PageLayout, d: f64) -> Rect {
    let (x, y) = ((b.x0 - d).floor().max(0.0), (b.y0 - d).floor().max(0.0));
    Rect::new(x, y, p.w.min((b.x1 + d).ceil()) - x, p.h.min((b.y1 + d).ceil()) - y)
}

/// 像目录的页：没有谱行、字占了页高的四分之一以上（两栏错行时多行会并成一带，不能按带数算）。
/// 谱行至少有两道小节线：笔画细的字体里曲号的「1」也够得上「竖细长」，一行里一道不算谱行。
fn looks_like_toc(body: &[Band], h: f64) -> bool {
    body.len() >= 3 && !body.iter().any(|b| is_music_band(b) && b.bars >= 2) && body.iter().map(|b| b.y1 - b.y0).sum::<f64>() >= h * 0.25
}

/// 一带 OCR 里读出调号：按横向次序把框拼起来再认（「1=」「E」常被检测切成几框）。
fn reads_key(lines: &[OcrLine]) -> bool {
    let mut ls: Vec<&OcrLine> = lines.iter().collect();
    ls.sort_by(|a, b| a.bbox.x.total_cmp(&b.bbox.x));
    KEY_RE.is_match(&ls.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" "))
}

fn overlap_y(a: &Rect, b: &Rect) -> f64 {
    overlap1d(a.y, a.bottom(), b.y, b.bottom())
}

/// 标题带的 OCR → 曲名 + 曲号。带里读出调号（`1=`），或大字比本页字行高出 15% 且读得到曲号，才算标题
/// （有的本子某首歌词字号比别的大，光凭字大会把歌词行认成标题；段号「1.」不算曲号）。
/// 曲名：与最高那框（按墨迹实高）等高、横排相挨的各框里各取最长一段汉字拼起来（「圣　哉」检测常切成两框），字间空格与同一字形的重读去掉；
/// 曲号：不属于调号、拍号（`4/4`）、出处（`诗67篇`、`33:8`）的独立整数里最靠两端的那个；曲号紧挨调号读成一串（「115 1=C」→「1151=C」）时去掉末位的 1。
/// `key_below`：调号印在下面的页眉行里（调用方已查过），与同排读出调号同等对待。
pub fn parse_title(lines: &[OcrLine], band_ix: usize, band: &Band, p: &PageLayout, ink_h: &dyn Fn(&Rect) -> f64, key_below: bool) -> Option<TitleHit> {
    let cjk: Vec<&OcrLine> = lines.iter().filter(|l| has_cjk(&l.text)).collect();
    if cjk.is_empty() {
        return None;
    }
    let has_key = key_below || reads_key(lines);
    // 字高按框里墨迹的实际高度比：检测框高带着外扩的边，旁边小一号的分类字（「教会」）框高也差不多
    let ink: Vec<f64> = cjk.iter().map(|l| ink_h(&l.bbox)).collect();
    let mi = (0..cjk.len()).fold(0, |a, i| if ink[i] > ink[a] { i } else { a });
    let (main, main_h) = (cjk[mi], ink[mi]);
    // 单字框（含「诗103:11」这类出处只有一个汉字的框）放宽到墨高 0.75 倍并要求与最高框中线对齐：「二」「心」本身扁，出处小一号
    let same_size = |i: usize| {
        let l = cjk[i];
        if l.text.chars().filter(|&c| is_cjk(c)).count() >= 2 {
            ink[i] >= main_h * 0.88
        } else {
            ink[i] >= main_h * 0.75 && (l.bbox.cy() - main.bbox.cy()).abs() <= main.bbox.h * 0.25
        }
    };
    // 与最高框等高、同一横排、且一框挨一框（间隙 ≤ 2.2 字高）的才拼：隔得远的同号字多是旁边的分类、出处
    let mut peers: Vec<usize> = (0..cjk.len()).filter(|&i| same_size(i) && overlap_y(&cjk[i].bbox, &main.bbox) >= cjk[i].bbox.h.min(main.bbox.h) * 0.5).collect();
    peers.sort_by(|&a, &b| cjk[a].bbox.x.total_cmp(&cjk[b].bbox.x));
    let at = peers.iter().position(|&i| i == mi)?;
    let near = |a: &Rect, b: &Rect| b.x - a.right() <= main.bbox.h * 2.2;
    let (mut lo, mut hi) = (at, at);
    while lo > 0 && near(&cjk[peers[lo - 1]].bbox, &cjk[peers[lo]].bbox) {
        lo -= 1;
    }
    while hi + 1 < peers.len() && near(&cjk[peers[hi]].bbox, &cjk[peers[hi + 1]].bbox) {
        hi += 1;
    }
    let parts: Vec<&OcrLine> = peers[lo..=hi].iter().map(|&i| cjk[i]).collect();
    let title: String = drop_overlap_twins(&parts, main_h)
        .iter()
        .map(|l| {
            let t: String = dedupe_chars(l).chars().filter(|c| !c.is_whitespace()).collect();
            let best = CJK_RUN.find_iter(&t).map(|m| m.as_str()).filter(|r| has_cjk(r)).fold("", |a, b| if b.chars().count() > a.chars().count() { b } else { a });
            best.to_string()
        })
        .collect::<String>()
        // 首尾的点号只在拼好的整个曲名上去（框常在逗号处切开：「神啊，」「愿列邦称赞祢」）
        .trim_matches(|c| c == '·' || c == '、' || c == '，')
        .to_string();

    struct Num {
        v: u32,
        x: f64,
        x0: f64,
        x1: f64,
    }
    let mut nums: Vec<Num> = Vec::new();
    for l in lines {
        let t = &l.text;
        let tl = t.chars().count();
        for m in DIGITS.find_iter(t) {
            let mut digits = m.as_str();
            let before = t[..m.start()].trim_end();
            let after = t[m.end()..].trim_start();
            if after.starts_with(['=', '＝']) {
                if digits.len() < 2 || !digits.ends_with('1') {
                    continue; // 调号本身
                }
                digits = &digits[..digits.len() - 1];
            } else if before.ends_with(['=', '＝', ':', '：', '/', '／']) || after.starts_with([':', '：', '/', '／']) {
                continue; // 4/4、33:8
            }
            if before.ends_with(['诗', '篇', '第', '章', '节']) || after.starts_with(['篇', '章', '节', '首', '.', '．', '、']) {
                continue; // 出处、段号「1.」
            }
            let Ok(v) = digits.parse::<u64>() else { continue };
            if !(1..=9999).contains(&v) {
                continue;
            }
            let k0 = t[..m.start()].chars().count();
            let at = |k: usize| if l.chars.len() == tl { l.chars[k].cx } else { l.bbox.x + ((k as f64 + 0.5) / tl.max(1) as f64) * l.bbox.w };
            let (x0, x1) = (at(k0), at(k0 + digits.len() - 1));
            nums.push(Num { v: v as u32, x: x0, x0, x1 });
        }
    }
    // 最靠左（在曲名左边）或最靠右（在曲名右边）的数；两边都有取离带边更近的
    let mid = main.bbox.cx();
    let left = nums.iter().filter(|n| n.x < mid).min_by(|a, b| a.x.total_cmp(&b.x));
    let right = nums.iter().filter(|n| n.x >= mid).max_by(|a, b| a.x.total_cmp(&b.x));
    let pick = match (left, right) {
        (Some(l), Some(r)) => Some(if l.x - band.x0 <= band.x1 - r.x { l } else { r }),
        (l, r) => l.or(r),
    };
    let number = pick.map(|n| n.v);
    // 没读出调号的，要字比本页字行大、且读得到曲号才算（防大字号歌词行）；本页有铺开的大字歌词行时，大字还要比歌词字大 15%
    if !has_key && (band.big_h < p.text_h.max(p.lyric_h) * 1.15 || number.is_none()) {
        return None;
    }
    // 整段重认的范围：往左并上拍号（含「/」或「=」的框）之后、紧挨着曲名的框——疏排的「二」会被单独读成「1」、不算汉字
    let fence = lines.iter().filter(|l| l.text.contains(['=', '＝', '/', '／'])).map(|l| l.bbox.right()).fold(f64::NEG_INFINITY, f64::max);
    let mut extra: Vec<&OcrLine> = lines
        .iter()
        .filter(|l| {
            !parts.iter().any(|q| std::ptr::eq(*q, *l))
                && l.bbox.x >= fence
                && l.bbox.right() <= parts[0].bbox.x
                && l.bbox.h >= main.bbox.h * 0.6
                && overlap_y(&l.bbox, &main.bbox) >= l.bbox.h.min(main.bbox.h) * 0.5
        })
        .collect();
    extra.sort_by(|a, b| b.bbox.x.total_cmp(&a.bbox.x));
    let mut all: Vec<&OcrLine> = parts.clone();
    for l in extra {
        if all[0].bbox.x - l.bbox.right() <= main.bbox.h * 2.2 {
            all.insert(0, l);
        }
    }
    let title_box = (all.len() > 1).then(|| rects_box(all.iter().map(|l| l.bbox)));
    Some(TitleHit { band: band_ix, title, number, number_span: pick.map(|n| (n.x0, n.x1)), title_box })
}

/// 检测框左右相叠时，叠住的那个字两框各读一遍（「神是」「是爱」、「1=E4/4三」「主的羊…」——「三」是「主」被前框截去下半）：
/// 前框末一个汉字与后框头一个汉字左缘相差不到半个字高，是同一个字形，留离自己框的相叠那条边远的（读的是整字），另一个去掉。
fn drop_overlap_twins(parts: &[&OcrLine], char_h: f64) -> Vec<OcrLine> {
    let mut out: Vec<OcrLine> = parts.iter().map(|l| (*l).clone()).collect();
    for k in 1..out.len() {
        let (a, b) = (&out[k - 1], &out[k]);
        if b.bbox.x >= a.bbox.right() || !a.chars_aligned() || !b.chars_aligned() {
            continue;
        }
        let cjk1 = |c: &crate::ocr::OChar| c.text.chars().next().is_some_and(is_cjk);
        let (Some(ia), Some(ib)) = (a.chars.iter().rposition(cjk1), b.chars.iter().position(cjk1)) else { continue };
        if (b.chars[ib].cx - a.chars[ia].cx).abs() >= char_h * 0.5 {
            continue;
        }
        // 前框的字离前框右沿远 → 前框读的是整字，去后框那个；反之去前框那个
        let (j, i) = if a.bbox.right() - a.chars[ia].cx > b.chars[ib].cx - b.bbox.x { (k, ib) } else { (k - 1, ia) };
        let l = &mut out[j];
        l.chars.remove(i);
        l.text = l.chars.iter().map(|c| c.text.as_str()).collect();
    }
    out
}

/// 一个字被识别读成两个（CTC 在一个宽字形里前后两段各出一类：「我们神」读成「我们门神」）：
/// 相邻两字横坐标之差不到本框汉字字距中位的 0.35 倍，后一个是同一个字形的重读，去掉。
fn dedupe_chars(l: &OcrLine) -> String {
    if !l.chars_aligned() {
        return l.text.clone();
    }
    let ch = &l.chars;
    let cjk1 = |s: &str| s.chars().next().is_some_and(is_cjk);
    let mut steps: Vec<f64> = (1..ch.len()).filter(|&k| cjk1(&ch[k].text) && cjk1(&ch[k - 1].text)).map(|k| ch[k].cx - ch[k - 1].cx).collect();
    steps.sort_by(f64::total_cmp);
    let pitch = if steps.len() >= 2 { steps[steps.len() >> 1] } else { 0.0 };
    if pitch == 0.0 {
        return l.text.clone();
    }
    let (mut out, mut prev) = (String::new(), f64::NEG_INFINITY);
    for c in ch {
        if cjk1(&c.text) && c.cx - prev < pitch * 0.35 {
            continue;
        }
        out.push_str(&c.text);
        if cjk1(&c.text) {
            prev = c.cx;
        }
    }
    out
}

/// 疏排标题（「二　十　心」）检测切成一字一框，框又裁得紧，单字识别很差（「二」读成「IL」、「十」读成「士」）。
/// 把曲名整段（首框到末框）裁成一条、四周垫白再识别一次；只留汉字。
fn reread_title(bin: &Binary, b: &Rect, ocr: &CachedOcr) -> Option<String> {
    let r = Rect::new(b.x.round(), b.y.round(), b.w.round(), b.h.round());
    let t = reread(ocr, bin, &r, (r.h * 0.25).round().max(0.0) as usize)?;
    let t: String = t.chars().filter(|&c| is_cjk(c)).collect();
    (!t.is_empty()).then_some(t)
}

static TOC_JUNK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s*＊—–\-.…·]+").unwrap());
static TRAIL_NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?[^0-9\s])\s*([0-9\s]*[0-9])$").unwrap());
static LEAD_NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]{1,4})\s*([^0-9].*)$").unwrap());

fn is_num_text(t: &str) -> bool {
    t.chars().all(|c| c.is_ascii_digit() || c.is_whitespace()) && t.chars().any(|c| c.is_ascii_digit())
}

/// 目录页整页 OCR → 条目。一条 = 文字 + 曲号 + 页码（「天使歌声 59 46」）。检测常把文字与数字切成两框、
/// 两个数又时分时合（「5946」「346」「267」），故先按纵向位置聚成行、行内按横坐标排，数字框再按字距拆数
/// （字距大于全页数内字距中位的 1.6 倍就断开）。文字后跟 ≥2 个数 → 取末两个为曲号、页码；经文目录「经文 首句 曲号 页码」同样适用。
pub fn parse_toc(lines: &[OcrLine]) -> Vec<TocEntry> {
    // 全页数内字距：数字框里相邻两字的横距（取 0.3 分位）
    let mut steps: Vec<f64> = Vec::new();
    for l in lines {
        if !is_num_text(&l.text) || !l.chars_aligned() {
            continue;
        }
        let cs: Vec<_> = l.chars.iter().filter(|c| c.text.chars().all(|d| d.is_ascii_digit())).collect();
        for k in 1..cs.len() {
            steps.push(cs[k].cx - cs[k - 1].cx);
        }
    }
    steps.sort_by(f64::total_cmp);
    let pitch = if steps.is_empty() { 0.0 } else { steps[(steps.len() as f64 * 0.3).floor() as usize] };

    let mut hs: Vec<f64> = lines.iter().map(|l| l.bbox.h).collect();
    hs.sort_by(f64::total_cmp);
    let tol = hs.get(hs.len() / 2).copied().unwrap_or(40.0) * 0.5;
    let mut sorted: Vec<&OcrLine> = lines.iter().collect();
    sorted.sort_by(|a, b| a.bbox.cy().total_cmp(&b.bbox.cy()));
    let mut rows: Vec<Vec<&OcrLine>> = Vec::new();
    for l in sorted {
        match rows.last_mut() {
            Some(row) if (l.bbox.cy() - row[0].bbox.cy()).abs() <= tol => row.push(l),
            _ => rows.push(vec![l]),
        }
    }

    let mut out = Vec::new();
    for row in rows.iter_mut() {
        row.sort_by(|a, b| a.bbox.x.total_cmp(&b.bbox.x));
        let (mut text, mut nums) = (String::new(), Vec::<u32>::new());
        let flush = |text: &mut String, nums: &mut Vec<u32>, out: &mut Vec<TocEntry>| {
            let t = TOC_JUNK.replace_all(text, " ").trim().to_string();
            if has_cjk(&t) && nums.len() >= 2 {
                out.push(TocEntry { text: t, number: nums[nums.len() - 2], page: Some(nums[nums.len() - 1]) });
            }
            text.clear();
            nums.clear();
        };
        for l in row.iter() {
            if is_num_text(&l.text) {
                nums.extend(split_numbers(l, pitch));
            } else {
                // 文字框尾巴上粘着的数（「主啊我赞美 1」）
                if !nums.is_empty() {
                    flush(&mut text, &mut nums, &mut out);
                }
                match TRAIL_NUM.captures(&l.text) {
                    Some(m) if has_cjk(&m[1]) => {
                        text.push_str(&m[1]);
                        nums.extend(m[2].split_whitespace().filter_map(|s| s.parse::<u32>().ok()));
                    }
                    _ => text.push_str(&l.text),
                }
            }
        }
        flush(&mut text, &mut nums, &mut out);
    }
    // 只列「曲号 曲名」、不带页码的目录（两栏排）：曲号在前、紧跟汉字。按「文字 + 两个数」认出的条目不到它的一半才改用它
    let lead = number_first_toc(&rows);
    if lead.len() > out.len() * 2 {
        lead
    } else {
        out
    }
}

/// 「曲号 曲名」式目录行：数字框后接汉字框，或一个框里数在前、字在后。
fn number_first_toc(rows: &[Vec<&OcrLine>]) -> Vec<TocEntry> {
    let mut out = Vec::new();
    for row in rows {
        let mut num: Option<u32> = None;
        for l in row {
            let t = l.text.trim();
            if (1..=4).contains(&t.len()) && t.chars().all(|c| c.is_ascii_digit()) {
                num = t.parse().ok();
                continue;
            }
            let (n, text) = match LEAD_NUM.captures(t) {
                Some(m) => (m[1].parse().ok(), m[2].to_string()),
                None => (num, t.to_string()),
            };
            num = None;
            let name = TOC_JUNK.replace_all(&text, "").trim_end_matches(|c: char| c.is_ascii_digit()).to_string();
            if let Some(n) = n {
                if has_cjk(&name) {
                    out.push(TocEntry { text: name, number: n, page: None });
                }
            }
        }
    }
    out
}

/// 一个纯数字框 → 若干数：空格处断，字距明显大于数内字距处也断。
fn split_numbers(l: &OcrLine, pitch: f64) -> Vec<u32> {
    let aligned = l.chars_aligned();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev_x = f64::NEG_INFINITY;
    let push = |cur: &mut String, out: &mut Vec<u32>| {
        if !cur.is_empty() {
            if let Ok(v) = cur.parse() {
                out.push(v);
            }
            cur.clear();
        }
    };
    for (k, c) in l.text.chars().enumerate() {
        if !c.is_ascii_digit() {
            push(&mut cur, &mut out);
            prev_x = f64::NEG_INFINITY;
            continue;
        }
        let x = if aligned { l.chars[k].cx } else { f64::NAN };
        if !cur.is_empty() && aligned && pitch > 0.0 && x - prev_x > pitch * 1.6 {
            push(&mut cur, &mut out);
        }
        cur.push(c);
        prev_x = x;
    }
    push(&mut cur, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocr::OChar;

    fn line(text: &str, x: f64, y: f64, w: f64, h: f64) -> OcrLine {
        let n = text.chars().count() as f64;
        let chars = text.chars().enumerate().map(|(i, c)| OChar { text: c.to_string(), cx: x + w * i as f64 / n, x1: x + w * (i as f64 + 1.0) / n }).collect();
        OcrLine { text: text.into(), bbox: Rect::new(x, y, w, h), chars }
    }

    fn band() -> Band {
        Band { y0: 0.0, y1: 60.0, x0: 0.0, x1: 1000.0, tall: 4, bars: 0, flat: false, sq_h: 30.0, big_h: 50.0, boxes: vec![] }
    }

    fn page() -> PageLayout {
        PageLayout { w: 1000.0, h: 1400.0, char_h: 30.0, text_h: 30.0, lyric_h: 0.0, bands: vec![], paper: [255; 3] }
    }

    #[test]
    fn title_number_glued_to_key() {
        // 「115 1=C」读成「1151=C」：去掉末位的 1
        let lines = vec![line("1151=C", 0.0, 0.0, 200.0, 50.0), line("圣哉", 400.0, 0.0, 120.0, 50.0)];
        let t = parse_title(&lines, 0, &band(), &page(), &|r| r.h, false).unwrap();
        assert_eq!(t.title, "圣哉");
        assert_eq!(t.number, Some(115));
    }

    #[test]
    fn title_skips_meter_and_reference() {
        let lines = vec![line("1=D 4/4", 0.0, 0.0, 200.0, 50.0), line("主啊我赞美你", 400.0, 0.0, 300.0, 50.0), line("诗67篇", 800.0, 0.0, 120.0, 30.0)];
        let t = parse_title(&lines, 0, &band(), &page(), &|r| r.h, false).unwrap();
        assert_eq!(t.title, "主啊我赞美你");
        assert_eq!(t.number, None);
    }

    #[test]
    fn big_lyric_line_is_not_title() {
        // 没调号、读不到曲号的大字行不是标题
        let lines = vec![line("主啊我赞美你", 0.0, 0.0, 300.0, 50.0)];
        assert!(parse_title(&lines, 0, &band(), &page(), &|r| r.h, false).is_none());
    }

    #[test]
    fn overlapping_boxes_read_char_twice() {
        let mut a = line("神是", 594.0, 0.0, 200.0, 50.0);
        a.chars[0].cx = 633.0;
        a.chars[1].cx = 738.0;
        let mut b = line("是爱", 752.0, 0.0, 140.0, 50.0);
        b.chars[1].cx = 854.0;
        let t = parse_title(&[line("138", 181.0, 0.0, 105.0, 50.0), line("1=F4/4", 327.0, 0.0, 188.0, 50.0), a, b], 0, &band(), &page(), &|r| r.h, false).unwrap();
        assert_eq!(t.title, "神是爱");
        let mut a = line("1=E4/4三", 264.0, 0.0, 233.0, 50.0);
        a.chars[6].cx = 484.0;
        let mut b = line("主的羊", 467.0, 0.0, 200.0, 50.0);
        b.chars[0].cx = 504.0;
        let t = parse_title(&[a, b], 0, &band(), &page(), &|r| r.h, false).unwrap();
        assert_eq!(t.title, "主的羊");
    }

    #[test]
    fn toc_rows() {
        let lines = vec![line("天使歌声", 0.0, 0.0, 200.0, 40.0), line("59 46", 600.0, 2.0, 100.0, 40.0), line("主啊我赞美 1", 0.0, 60.0, 300.0, 40.0), line("1", 650.0, 60.0, 20.0, 40.0)];
        let t = parse_toc(&lines);
        assert_eq!(t, vec![
            TocEntry { text: "天使歌声".into(), number: 59, page: Some(46) },
            TocEntry { text: "主啊我赞美".into(), number: 1, page: Some(1) },
        ]);
    }

    #[test]
    fn toc_number_first() {
        let lines = vec![line("1 至于我", 0.0, 0.0, 200.0, 40.0), line("29", 600.0, 0.0, 40.0, 40.0), line("神啊我心坚定", 660.0, 0.0, 300.0, 40.0)];
        let t = parse_toc(&lines);
        assert_eq!(t.len(), 2);
        assert_eq!(t[1], TocEntry { text: "神啊我心坚定".into(), number: 29, page: None });
    }
}
