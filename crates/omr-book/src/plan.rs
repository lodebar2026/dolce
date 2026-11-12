//! 整本规划（纯计算，不碰像素）：印页码 → 歌谱区、目录投票、标题配号、分段、系统间距与边距、每首的摆放。
//! 对应 web `omr/booksplit/plan.ts`。
use crate::layout::{is_music_band, Band};
use crate::scan::{PageInfo, TocEntry};
use dolce_omr_core::geom::{median, quantile};
use dolce_omr_core::image::Rect;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// 歌谱区：`序号 − 印页码` 出现最多的那个差值所覆盖的页段（前后的封面、目录、附录不算）。
#[derive(Clone, Debug, PartialEq)]
pub struct BookRegion {
    pub first: usize,
    pub last: usize,
    /// 序号 − 印页码；没有可信页码时为 None。
    pub offset: Option<i64>,
}

impl BookRegion {
    /// 第 i 页（源序号）的印页码。
    pub fn printed(&self, i: usize) -> Option<i64> {
        self.offset.map(|o| i as i64 - o)
    }
}

pub fn find_region(pages: &[PageInfo]) -> BookRegion {
    let mut votes: BTreeMap<i64, usize> = BTreeMap::new();
    let mut order: Vec<i64> = Vec::new();
    for p in pages {
        if let Some(n) = p.printed {
            let k = p.index as i64 - n as i64;
            let v = votes.entry(k).or_insert(0);
            if *v == 0 {
                order.push(k);
            }
            *v += 1;
        }
    }
    // 票数相同取先出现的（同 TS 的 Map 迭代次序）
    let (mut offset, mut best) = (None, 0);
    for k in order {
        if votes[&k] > best {
            best = votes[&k];
            offset = Some(k);
        }
    }
    let Some(off) = offset.filter(|_| best >= 3) else {
        // 没有可信的页码：从第一页有标题的页到末页
        let first = pages.iter().find(|p| !p.titles.is_empty()).map_or(0, |p| p.index);
        return BookRegion { first, last: pages.len().saturating_sub(1), offset: None };
    };
    let hits: Vec<usize> = pages.iter().filter(|p| p.printed.is_some_and(|n| p.index as i64 - n as i64 == off)).map(|p| p.index).collect();
    BookRegion { first: hits[0], last: *hits.last().unwrap(), offset: Some(off) }
}

#[derive(Clone, Debug, Default)]
pub struct Toc {
    /// 曲号 → 印页码（投票、单调性筛过）。
    pub pages: BTreeMap<u32, u32>,
    /// 首句等文字（报告用）。
    pub texts: HashMap<u32, String>,
    /// 目录里有的全部曲号（含不带页码的条目、不含剔掉的）。
    pub numbers: BTreeSet<u32>,
    /// 读到了但与前后不单调、被剔掉的条目。
    pub dropped: Vec<TocEntry>,
}

/// 多份目录（首句、经文…）的条目投票：同一曲号取票最多的页码；再按曲号排序取页码不减的最长子序列，
/// 把 OCR 读错的号（页码跟前后对不上）剔掉。`max_page` 是歌谱区最后一页的印页码，超出的条目不收。
pub fn build_toc(entries: &[TocEntry], max_page: Option<i64>) -> Toc {
    let mut votes: BTreeMap<u32, BTreeMap<u32, usize>> = BTreeMap::new();
    let mut texts: HashMap<u32, String> = HashMap::new();
    let mut bare: BTreeSet<u32> = BTreeSet::new();
    // 一本书的目录要么都带页码、要么都不带：有带页码的条目时，不带的（前言、索引页上按「数 + 字」误认出来的）不收
    let paged = entries.iter().any(|e| e.page.is_some());
    for e in entries {
        let Some(page) = e.page else {
            if e.number >= 1 && !paged {
                // 不带页码的条目（只列「曲号 曲名」的目录）：只记号与文字
                bare.insert(e.number);
                texts.entry(e.number).or_insert_with(|| e.text.clone());
            }
            continue;
        };
        if e.number < 1 || page < 1 || max_page.is_some_and(|m| page as i64 > m) {
            continue;
        }
        *votes.entry(e.number).or_default().entry(page).or_insert(0) += 1;
        texts.entry(e.number).or_insert_with(|| e.text.clone());
    }
    // 同票取页码小的
    let cand: Vec<(u32, u32)> = votes.iter().map(|(&n, m)| (n, m.iter().fold((0u32, 0usize), |a, (&p, &v)| if v > a.1 { (p, v) } else { a }).0)).collect();
    let keep = longest_non_decreasing(&cand.iter().map(|c| c.1).collect::<Vec<_>>());
    let mut toc = Toc::default();
    for (i, &(n, page)) in cand.iter().enumerate() {
        if keep.contains(&i) {
            toc.pages.insert(n, page);
        } else {
            toc.dropped.push(TocEntry { text: texts.get(&n).cloned().unwrap_or_default(), number: n, page: Some(page) });
        }
    }
    let drop_nums: BTreeSet<u32> = toc.dropped.iter().map(|e| e.number).collect();
    toc.numbers = toc.pages.keys().copied().chain(bare.into_iter().filter(|n| !drop_nums.contains(n))).collect();
    toc.texts = texts;
    toc
}

/// 最长不减子序列的下标集合（O(n log n)）。
fn longest_non_decreasing(xs: &[u32]) -> BTreeSet<usize> {
    let (mut tails, mut tail_idx): (Vec<u32>, Vec<usize>) = (Vec::new(), Vec::new());
    let mut prev = vec![usize::MAX; xs.len()];
    for (i, &x) in xs.iter().enumerate() {
        let lo = tails.partition_point(|&t| t <= x);
        if lo == tails.len() {
            tails.push(x);
            tail_idx.push(i);
        } else {
            tails[lo] = x;
            tail_idx[lo] = i;
        }
        prev[i] = if lo > 0 { tail_idx[lo - 1] } else { usize::MAX };
    }
    let mut out = BTreeSet::new();
    let mut i = tail_idx.last().copied().unwrap_or(usize::MAX);
    while i != usize::MAX {
        out.insert(i);
        i = prev[i];
    }
    out
}

/// 一个标题的配号结果。
#[derive(Clone, Debug, Default)]
pub struct Assigned {
    pub number: Option<u32>,
    pub issues: Vec<String>,
}

/// 标题的键：(页序号, 本页第几个标题)。
pub type TitleKey = (usize, usize);

/// 给歌谱区里的标题配号。逐个标题、按页序与纵向次序：
///   1. 标题上读到的号在本页目录里 → 用它；
///   2. 读到的号接得上（比上一首大、跳不超过 6），且目录没说它在别的页（差一页以内不算）→ 用它；
///   3. 本页目录给的号数与标题数相同 → 照目录次序配；
///   4. 本页目录还剩比上一首大的号 → 用最小那个；
///   5. 都不行 → 上一首 + 1。
///
/// 与读到的号不一致处记进 issues。
pub fn assign_numbers(pages: &[PageInfo], region: &BookRegion, toc: &Toc) -> HashMap<TitleKey, Assigned> {
    let mut by_page: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&n, &p) in &toc.pages {
        by_page.entry(p).or_default().push(n);
    }
    for ns in by_page.values_mut() {
        ns.sort_unstable();
    }
    let mut out = HashMap::new();
    let mut prev = 0u32;
    for i in region.first..=region.last {
        let p = &pages[i];
        if p.titles.is_empty() {
            continue;
        }
        let printed = region.printed(i);
        let expect: Vec<u32> = printed.and_then(|pp| u32::try_from(pp).ok()).and_then(|pp| by_page.get(&pp)).cloned().unwrap_or_default();
        let mut left = expect.clone();
        let together = expect.len() == p.titles.len();
        for (k, t) in p.titles.iter().enumerate() {
            let mut issues = Vec::new();
            let r = t.number;
            let tp = r.and_then(|r| toc.pages.get(&r)).copied();
            let fits = r.is_some_and(|r| r > prev && r <= prev + 6) && (tp.is_none() || printed.is_none() || (tp.unwrap() as i64 - printed.unwrap()).abs() <= 1);
            let mut how = "目录";
            let n = if r.is_some_and(|r| left.contains(&r)) || fits {
                r.unwrap()
            } else if together && expect[k] > prev {
                expect[k]
            } else if let Some(&x) = left.iter().find(|&&x| x > prev) {
                x
            } else {
                how = "前后顺序";
                prev + 1
            };
            if let Some(j) = left.iter().position(|&x| x == n) {
                left.remove(j);
            }
            match r {
                Some(r) if r != n => issues.push(format!("标题上读到曲号 {r}，按{how}定为 {n}")),
                None => issues.push(format!("标题上没读到曲号，按{how}定为 {n}")),
                _ => {}
            }
            out.insert((i, k), Assigned { number: Some(n), issues });
            prev = n;
        }
    }
    out
}

/// 一页的正文带按标题切开后，属于某首歌的一段带（带下标）。
#[derive(Clone, Debug)]
pub struct Segment {
    pub page: usize,
    pub bands: Vec<usize>,
}

/// 切出来的一首：标题、配号与各段。
#[derive(Clone, Debug)]
pub struct SongSegs {
    pub title: String,
    pub number: Option<u32>,
    pub issues: Vec<String>,
    pub segs: Vec<Segment>,
}

/// 歌谱区按标题切成每首的分段。标题之前、不接任何一首的内容记进 orphans。
pub fn segment_songs(pages: &[PageInfo], region: &BookRegion, nums: &HashMap<TitleKey, Assigned>) -> (Vec<SongSegs>, Vec<usize>) {
    let mut songs: Vec<SongSegs> = Vec::new();
    let mut orphans: Vec<usize> = Vec::new();
    for i in region.first..=region.last {
        let p = &pages[i];
        let mut seg: Option<Segment> = (!songs.is_empty()).then(|| Segment { page: i, bands: Vec::new() });
        for b in 0..p.body().len() {
            if let Some(k) = p.titles.iter().position(|t| t.band == b) {
                if let Some(s) = seg.take().filter(|s| !s.bands.is_empty()) {
                    if let Some(last) = songs.last_mut() {
                        last.segs.push(s);
                    }
                }
                let a = nums.get(&(i, k)).cloned().unwrap_or_default();
                songs.push(SongSegs { title: p.titles[k].title.clone(), number: a.number, issues: a.issues, segs: Vec::new() });
                seg = Some(Segment { page: i, bands: vec![b] });
            } else if let Some(s) = seg.as_mut() {
                s.bands.push(b);
            } else if !orphans.contains(&i) {
                orphans.push(i);
            }
        }
        if let Some(s) = seg.filter(|s| !s.bands.is_empty()) {
            if let Some(last) = songs.last_mut() {
                last.segs.push(s);
            }
        }
    }
    (songs, orphans)
}

fn is_title_like(b: &Band) -> bool {
    b.tall >= 2
}

/// 系统间距：一首里每个「系统」（谱行连同上面贴着的弧线带）顶上的空白，第一个系统（紧接标题）除外。
pub fn system_gaps(pages: &[PageInfo], segs: &[Segment], char_h: f64) -> Vec<f64> {
    let mut gaps = Vec::new();
    for s in segs {
        let bands: Vec<&Band> = s.bands.iter().map(|&b| &pages[s.page].body()[b]).collect();
        for k in 1..bands.len() {
            let b = bands[k];
            if !is_music_band(b) {
                continue;
            }
            // 系统顶：谱行上面紧贴的扁弧线带算进系统
            let mut top = k;
            while top >= 2 && bands[top - 1].flat && b.y0 - bands[top - 1].y1 < char_h * 0.8 {
                top -= 1;
            }
            let above = bands[top - 1];
            if top - 1 == 0 && is_title_like(above) {
                continue; // 标题下第一个系统
            }
            gaps.push(bands[top].y0 - above.y1);
        }
    }
    gaps
}

/// 合成参数：版心距纸边的边距与版心宽（全书中位）。
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Margins {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
    pub type_w: f64,
}

/// 全书边距：歌谱区各页版心距纸边的分位数（底边取 0.3 分位，免得收尾半页的大片空白把它抬高）。
pub fn book_margins(pages: &[PageInfo], region: &BookRegion) -> Margins {
    let (mut l, mut r, mut t, mut b, mut w) = (vec![], vec![], vec![], vec![], vec![]);
    for p in &pages[region.first..=region.last] {
        let body = p.body();
        if body.is_empty() {
            continue;
        }
        let (x0, x1) = type_x(p);
        l.push(x0);
        r.push(p.layout.w - x1);
        w.push(x1 - x0);
        t.push(body[0].y0);
        b.push(p.layout.h - body[body.len() - 1].y1);
    }
    let q = quantile(&b, 0.3);
    Margins {
        left: median(&l, 150.0).round(),
        right: median(&r, 150.0).round(),
        top: median(&t, 200.0).round(),
        bottom: if q == 0.0 { 200.0 } else { q.round() },
        type_w: median(&w, 1100.0).round(),
    }
}

/// 一页的版心左缘与右缘（各段按左缘对齐）。
fn type_x(p: &PageInfo) -> (f64, f64) {
    let body = p.body();
    (body.iter().map(|b| b.x0).fold(f64::INFINITY, f64::min), body.iter().map(|b| b.x1).fold(f64::NEG_INFINITY, f64::max))
}

/// 一首歌在某一页上的一段。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    pub page: usize,
    /// 段内容的纵向范围 [y0, y1)（源图像素）。
    pub y0: f64,
    pub y1: f64,
    /// 该页版心左缘（各段按它对齐）。
    pub type_x: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongPlan {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    pub title: String,
    /// 起始页（源序号，0 起）。
    pub start_page: usize,
    pub pieces: Vec<Piece>,
    /// 拼缝处用的系统间距（像素）。
    pub seam_gap: f64,
    pub issues: Vec<String>,
}

/// 分段 → SongPlan（各段纵向范围 + 拼缝间距）。
pub fn plan_songs(pages: &[PageInfo], songs: &[SongSegs]) -> Vec<SongPlan> {
    let mut all = Vec::new();
    let per: Vec<Vec<f64>> = songs
        .iter()
        .map(|s| {
            let ch = s.segs.first().and_then(|g| pages.get(g.page)).map_or(36.0, |p| p.layout.char_h);
            let g = system_gaps(pages, &s.segs, ch);
            all.extend_from_slice(&g);
            g
        })
        .collect();
    let global_gap = median(&all, 60.0);
    songs
        .iter()
        .zip(per)
        .map(|(s, g)| SongPlan {
            number: s.number,
            title: s.title.clone(),
            start_page: s.segs.first().map_or(0, |g| g.page),
            pieces: s
                .segs
                .iter()
                .map(|g| {
                    let body = pages[g.page].body();
                    Piece { page: g.page, y0: body[g.bands[0]].y0, y1: body[*g.bands.last().unwrap()].y1, type_x: type_x(&pages[g.page]).0 }
                })
                .collect(),
            seam_gap: if g.is_empty() { global_gap } else { median(&g, 0.0) }.round(),
            issues: s.issues.clone(),
        })
        .collect()
}

/// 一张输出图的摆放：每段从源页 `src` 矩形拷到画布 (dx, dy)，其余填纸色。
#[derive(Clone, Debug, Serialize)]
pub struct Placement {
    pub page: usize,
    pub src: Rect,
    pub dx: f64,
    pub dy: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Layout {
    pub width: f64,
    pub height: f64,
    pub paper: [u8; 3],
    pub parts: Vec<Placement>,
    /// 拷进来的源图里夹带的页码，画布坐标，涂纸色。
    pub erase: Vec<Rect>,
}

/// 一首的摆放：画布宽 = 左边距 + max(全书版心宽, 各段实宽) + 右边距；各段按本页版心左缘对齐、竖着排，
/// 段与段之间隔一个系统间距；段的上下多拷一点源图（不超过到邻带空白的一半），其余填纸色。
pub fn layout_song(song: &SongPlan, pages: &[PageInfo], m: &Margins) -> Layout {
    let mut width = 0f64;
    for pc in &song.pieces {
        width = width.max(type_x(&pages[pc.page]).1 - pc.type_x);
    }
    width = m.left + m.type_w.max(width) + m.right;
    let (mut parts, mut erase) = (Vec::new(), Vec::new());
    let mut y = m.top;
    for (k, pc) in song.pieces.iter().enumerate() {
        let p = &pages[pc.page];
        let (above, below) = room(p, pc);
        let pad_t = (p.layout.char_h * 0.3).round().min(above);
        let pad_b = (p.layout.char_h * 0.3).round().min(below);
        let sx = (pc.type_x - m.left).max(0.0);
        let sx1 = p.layout.w.min(pc.type_x - m.left + width);
        let (sy, sy1) = (pc.y0 - pad_t, pc.y1 + pad_b);
        let src = Rect::new(sx, sy, sx1 - sx, sy1 - sy);
        let (dx, dy) = (sx - (pc.type_x - m.left), y - pad_t);
        parts.push(Placement { page: pc.page, src, dx, dy });
        // 拷进来的范围里夹着页码（与末行同排、或贴得很近）→ 画布上涂纸色
        if let Some(f) = p.footer {
            if f.x < src.right() && f.right() > src.x && f.y < src.bottom() && f.bottom() > src.y {
                let d = (p.layout.char_h * 0.15).round();
                erase.push(Rect::new(f.x - d - src.x + dx, f.y - d - src.y + dy, f.w + 2.0 * d, f.h + 2.0 * d));
            }
        }
        y += pc.y1 - pc.y0;
        if k + 1 < song.pieces.len() {
            y += song.seam_gap;
        }
    }
    let paper = song.pieces.first().map_or([255; 3], |pc| pages[pc.page].layout.paper);
    Layout { width, height: y + m.bottom, paper, parts, erase }
}

/// 段上下可多拷的源图高度：到相邻、不属于本段的带（或纸边）空白的一半。
fn room(p: &PageInfo, pc: &Piece) -> (f64, f64) {
    let (mut above, mut below) = (pc.y0, p.layout.h - pc.y1);
    for b in p.body() {
        if b.y1 <= pc.y0 {
            above = above.min(((pc.y0 - b.y1) / 2.0).floor());
        }
        if b.y0 >= pc.y1 {
            below = below.min(((b.y0 - pc.y1) / 2.0).floor());
        }
    }
    (above.max(0.0), below.max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::PageLayout;
    use crate::scan::TitleHit;

    fn e(n: u32, p: Option<u32>) -> TocEntry {
        TocEntry { text: format!("曲{n}"), number: n, page: p }
    }

    #[test]
    fn toc_votes_and_drops_non_monotonic() {
        // 3 号读错成页 90（前后 10、12），剔掉；1 号两份目录一份读成 11，按票数取 10
        let t = build_toc(&[e(1, Some(10)), e(1, Some(10)), e(1, Some(11)), e(2, Some(11)), e(3, Some(90)), e(4, Some(12))], Some(100));
        assert_eq!(t.pages.get(&1), Some(&10));
        assert!(!t.pages.contains_key(&3));
        assert_eq!(t.dropped.len(), 1);
        assert_eq!(t.numbers.iter().copied().collect::<Vec<_>>(), vec![1, 2, 4]);
    }

    #[test]
    fn toc_paged_ignores_bare() {
        let t = build_toc(&[e(1, Some(1)), e(7, None)], None);
        assert!(!t.numbers.contains(&7));
        let t = build_toc(&[e(1, None), e(2, None)], None);
        assert_eq!(t.numbers.len(), 2);
    }

    fn page(index: usize, printed: Option<u32>, titles: Vec<Option<u32>>) -> PageInfo {
        let band = |y: f64| Band { y0: y, y1: y + 40.0, x0: 100.0, x1: 900.0, tall: 0, bars: 2, flat: false, sq_h: 0.0, big_h: 0.0, boxes: vec![] };
        let bands: Vec<Band> = (0..4).map(|k| band(100.0 + k as f64 * 100.0)).collect();
        PageInfo {
            index,
            layout: PageLayout { w: 1000.0, h: 1400.0, char_h: 30.0, text_h: 30.0, lyric_h: 0.0, bands, paper: [255; 3] },
            printed,
            footer: None,
            footer_cands: vec![],
            titles: titles.into_iter().enumerate().map(|(k, n)| TitleHit { band: k * 2, title: format!("t{index}{k}"), number: n, number_span: None, title_box: None }).collect(),
            toc: vec![],
        }
    }

    #[test]
    fn assign_rules() {
        // 第 1 页两首：读到 1、没读到；第 2 页：读到 9（跳太多，目录说第 2 页是 3）
        let pages = vec![page(0, Some(1), vec![Some(1), None]), page(1, Some(2), vec![Some(9)]), page(2, Some(3), vec![]), page(3, Some(4), vec![])];
        let region = find_region(&pages);
        assert_eq!(region, BookRegion { first: 0, last: 3, offset: Some(-1) });
        let toc = build_toc(&[e(1, Some(1)), e(2, Some(1)), e(3, Some(2))], None);
        let a = assign_numbers(&pages, &region, &toc);
        assert_eq!(a[&(0, 0)].number, Some(1));
        assert_eq!(a[&(0, 1)].number, Some(2));
        assert_eq!(a[&(1, 0)].number, Some(3));
        assert_eq!(a[&(1, 0)].issues.len(), 1);
        let (songs, orphans) = segment_songs(&pages, &region, &a);
        assert!(orphans.is_empty());
        assert_eq!(songs.len(), 3);
        // 第 2 首从第 1 页第 3 带起、接第 2 页标题之前没有内容；第 3 首跨到第 3、4 页
        assert_eq!(songs[1].segs.len(), 1);
        assert_eq!(songs[2].segs.iter().map(|s| s.page).collect::<Vec<_>>(), vec![1, 2, 3]);
        let plans = plan_songs(&pages, &songs);
        let m = book_margins(&pages, &region);
        let l = layout_song(&plans[2], &pages, &m);
        assert_eq!(l.parts.len(), 3);
        assert_eq!(l.width, m.left + m.type_w + m.right);
        assert!(l.parts[1].dy > l.parts[0].dy);
    }
}
