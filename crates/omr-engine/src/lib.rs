//! 识别的统一入口：桌面版（Tauri 命令）、网页版（wasm）、命令行都经这里，不各自拼「文件 → 页面 → 判路 → 识别」。
//!
//! - [`Doc`]：打开 PDF（PDFium）或单张图片（图片直接当一页，不再像 TS 那样先封成 PDF）；页数、页尺寸、整页渲染
//! - [`recognize`]：判路（先按五线谱认，没有一页找到谱表就走简谱）、带进度与取消（[`Hook`]）
//! - [`Recognition`]：五线谱交会话（[`Session`]，改关联表 / 切分 / 钉住都在它上面），简谱交识别结果与识别用的二值图
//! - [`staff_binary`]：五线谱核对视图的底图（坐标与核对 JSON 一致）
//! - [`Handle`]：桌面版、网页版共用的文档句柄（请求与回应的字节 / JSON 格式）
use dolce_omr_core::image::Binary;
use dolce_omr_core::pixel::preprocess::otsu;
use dolce_omr_core::progress::Hook;
use dolce_omr_jianpu::result::RecognizedScore;
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::surface::Gray;
use dolce_omr_sheet::prims::VEC_SCALE;
use dolce_omr_source::raster::{image_file, page_image, SourceImage};
use dolce_omr_source::{ContentOpts, PdfDoc, Rendered};
use dolce_omr_staff::page::{recognize_source, Page, PageSource};
use dolce_omr_staff::session::Session;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

mod handle;

pub use dolce_omr_core::progress::{Step, CANCELLED};
pub use handle::{split_files, Handle};

/// 一份打开的文档：一个或几个文件（几张照片合成一首），页按文件次序接着编。
pub struct Doc {
    parts: Vec<Part>,
    /// 各页：(第几个文件, 文件内页号)
    index: Vec<(usize, usize)>,
    /// 分轮预取时各轮都从头识别，只看图、各轮不变的中间结果留在这里共用（见 [`Memo`]）
    memo: Memo,
}

/// 跨轮共用的中间结果，按所选页（`Opts::pages` 展开后的文档页号）存。
#[derive(Default)]
struct Memo {
    /// 自动档试过五线谱、没找到谱表的页组（试的那一轮没缺 OCR，结论各轮相同）
    staffless: Mutex<Vec<Vec<usize>>>,
    /// 简谱像素页准备好的墨层
    jianpu: Mutex<Option<(Vec<usize>, Arc<dolce_omr_jianpu::Prepared>)>>,
}

enum Part {
    Pdf(PdfDoc),
    Image(SourceImage),
}

/// 识别哪一路：自动（先试五线谱）/ 指定。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    #[default]
    Auto,
    Staff,
    Jianpu,
}

/// 识别选项。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Opts {
    pub kind: Kind,
    /// 只认这几页（0 起）；空 = 全部
    pub pages: Vec<usize>,
    /// 曲名（五线谱写进 `<work-title>`；编辑器给文件名）
    pub title: Option<String>,
}

pub enum Recognition {
    /// 五线谱（含混排）：`pages` = 各结果页对应文档的第几页（0 起；没找到谱表的页不在里面）
    Staff { session: Session, pages: Vec<usize> },
    /// 简谱：识别结果与识别用的二值图（各页上下拼起，结果坐标在它上面）
    Jianpu { score: RecognizedScore, binary: Binary },
}

impl Doc {
    /// 打开字节：`%PDF` 开头当 PDF，其余当图片。
    pub fn open(bytes: Vec<u8>) -> Result<Doc, String> {
        Doc::open_many(vec![bytes])
    }

    /// 打开几个文件，页按次序接起来。
    pub fn open_many(files: Vec<Vec<u8>>) -> Result<Doc, String> {
        let mut parts = Vec::new();
        let mut index = Vec::new();
        for (k, bytes) in files.into_iter().enumerate() {
            let p = if bytes.starts_with(b"%PDF") { Part::Pdf(PdfDoc::open(bytes)?) } else { Part::Image(image_file(&bytes)?) };
            let n = match &p {
                Part::Pdf(d) => d.page_count(),
                Part::Image(_) => 1,
            };
            index.extend((0..n).map(|i| (k, i)));
            parts.push(p);
        }
        if index.is_empty() {
            return Err("没有页面".into());
        }
        Ok(Doc { parts, index, memo: Memo::default() })
    }

    pub fn is_pdf(&self) -> bool {
        self.parts.iter().any(|p| matches!(p, Part::Pdf(_)))
    }

    pub fn page_count(&self) -> usize {
        self.index.len()
    }

    fn part(&self, i: usize) -> Result<(&Part, usize), String> {
        let &(k, j) = self.index.get(i).ok_or_else(|| format!("没有第 {} 页", i + 1))?;
        Ok((&self.parts[k], j))
    }

    /// 页尺寸：PDF 是点，图片是像素。
    pub fn page_size(&self, i: usize) -> Result<(f64, f64), String> {
        match self.part(i)? {
            (Part::Pdf(d), j) => d.page_size(j),
            (Part::Image(im), _) => Ok((im.w as f64, im.h as f64)),
        }
    }

    /// 整页渲染（RGBA）：PDF 每点 `scale` 像素；图片按 `scale` 缩放原图。
    pub fn render(&self, i: usize, scale: f64) -> Result<Rendered, String> {
        let im = match self.part(i)? {
            (Part::Pdf(d), j) => return d.render(j, scale),
            (Part::Image(im), _) => im,
        };
        let (w, h) = (((im.w as f64 * scale).round() as usize).max(1), ((im.h as f64 * scale).round() as usize).max(1));
        let mut rgba = vec![255u8; w * h * 4];
        for y in 0..h {
            let sy = (y * im.h / h).min(im.h - 1);
            for x in 0..w {
                let sx = (x * im.w / w).min(im.w - 1);
                let k = sy * im.w + sx;
                let px = &mut rgba[(y * w + x) * 4..(y * w + x) * 4 + 3];
                if im.rgb.len() == im.w * im.h * 3 {
                    px.copy_from_slice(&im.rgb[k * 3..k * 3 + 3]);
                } else {
                    px.fill(im.gray[k]);
                }
            }
        }
        Ok(Rendered { w, h, rgba })
    }

    /// 一页的识别输入（PDF 取内嵌图与矢量内容；文字层有不可靠字体的纯矢量页另渲一张灰度图）。
    pub fn source(&self, i: usize) -> Result<PageSource, String> {
        let (doc, i) = match self.part(i)? {
            (Part::Pdf(d), j) => (d, j),
            (Part::Image(im), _) => return Ok(PageSource { raster: Some(im.clone()), content: None, rendered: None }),
        };
        let pc = doc.content(i, ContentOpts { images: true, paths: true, text: true, outlines: true })?;
        let raster = page_image(&pc);
        let rendered = (raster.is_none() && !dolce_omr_source::vector::unreliable_fonts(&pc).is_empty())
            .then(|| doc.render(i, VEC_SCALE).ok())
            .flatten()
            .map(|r| gray_of(&r));
        Ok(PageSource { raster, content: Some(pc), rendered })
    }

    /// 各页的识别输入（`pages` 空 = 全部；取不出内容的页跳过）。
    pub fn sources(&self, pages: &[usize]) -> Result<Vec<(usize, PageSource)>, String> {
        let all: Vec<usize> = if pages.is_empty() { (0..self.page_count()).collect() } else { pages.to_vec() };
        Ok(all.into_iter().filter_map(|i| Some((i, self.source(i).ok()?))).collect())
    }
}

fn gray_of(r: &Rendered) -> Gray {
    Gray { w: r.w, h: r.h, data: r.rgba.chunks_exact(4).map(|p| ((p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) / 1000) as u8).collect() }
}

fn binarize(gray: &[u8], w: usize, h: usize) -> Binary {
    let (t, _) = otsu(gray);
    Binary { w, h, data: gray.iter().map(|&v| (v <= t) as u8).collect() }
}

/// 简谱准备好的墨层按哪几页存：所选页里有像素图的那些。
fn raster_key(srcs: &[(usize, PageSource)]) -> Vec<usize> {
    srcs.iter().filter(|s| s.1.raster.is_some()).map(|s| s.0).collect()
}

/// 这几页准备好的简谱墨层（之前某轮做过的）。
fn memo_jianpu(doc: &Doc, srcs: &[(usize, PageSource)]) -> Option<Arc<dolce_omr_jianpu::Prepared>> {
    let key = raster_key(srcs);
    doc.memo.jianpu.lock().ok().and_then(|m| m.as_ref().filter(|(k, _)| *k == key).map(|(_, p)| p.clone()))
}

/// 识别：五线谱各页先认（页级并行），一页谱表都没有（且没指定五线谱）就走简谱。
pub fn recognize(doc: &Doc, ocr: &CachedOcr, opts: &Opts, hook: &Hook) -> Result<Recognition, String> {
    let srcs = doc.sources(&opts.pages)?;
    hook.step(0, srcs.len() + 1, "page")?;
    let key: Vec<usize> = srcs.iter().map(|s| s.0).collect();
    let staffless = opts.kind == Kind::Auto && doc.memo.staffless.lock().is_ok_and(|v| v.contains(&key));
    if opts.kind != Kind::Jianpu && !staffless {
        // 自动档头一回试五线谱时，简谱的准备（只看图）在另一个线程同时做：没有谱表就接着用，有就丢掉
        #[cfg(feature = "parallel")]
        let (pages, prep) = if opts.kind == Kind::Auto && memo_jianpu(doc, &srcs).is_none() && srcs.iter().any(|s| s.1.raster.is_some()) {
            let imgs: Vec<SourceImage> = srcs.iter().filter_map(|s| s.1.raster.clone()).collect();
            let (pages, prep) = rayon::join(|| staff_pages(&srcs, ocr, hook), || dolce_omr_jianpu::prepare(&imgs));
            (pages?, prep.ok())
        } else {
            (staff_pages(&srcs, ocr, hook)?, None)
        };
        #[cfg(not(feature = "parallel"))]
        let (pages, prep): (_, Option<dolce_omr_jianpu::Prepared>) = (staff_pages(&srcs, ocr, hook)?, None);
        if let (true, Some(p)) = (pages.is_empty(), prep) {
            if let Ok(mut m) = doc.memo.jianpu.lock() {
                *m = Some((raster_key(&srcs), Arc::new(p)));
            }
        }
        // 没找到谱表、且这一轮试五线谱时没缺 OCR：结论只取决于图与已缓存的读数，后面各轮不必再试
        if pages.is_empty() && opts.kind == Kind::Auto && !ocr.stalled() {
            if let Ok(mut v) = doc.memo.staffless.lock() {
                v.push(key.clone());
            }
        }
        if !pages.is_empty() || opts.kind == Kind::Staff {
            if pages.is_empty() {
                return Err("没有找到谱表".into());
            }
            hook.step(srcs.len(), srcs.len() + 1, "assemble")?;
            let (idx, pages): (Vec<usize>, Vec<Page>) = pages.into_iter().unzip();
            return Ok(Recognition::Staff { session: Session::new(pages, opts.title.clone()), pages: idx });
        }
    }
    jianpu(doc, srcs, ocr, hook)
}

/// 五线谱逐页识别（找不到谱表的页丢掉）；回 (文档页号, 页)。
fn staff_pages(srcs: &[(usize, PageSource)], ocr: &CachedOcr, hook: &Hook) -> Result<Vec<(usize, Page)>, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let done = AtomicUsize::new(0);
    let total = srcs.len() + 1;
    let one = |(i, s): &(usize, PageSource)| -> Result<Option<(usize, Page)>, String> {
        if hook.cancelled() {
            return Err(CANCELLED.into());
        }
        let p = recognize_source(s, Some(ocr)).map(|p| (*i, p));
        hook.step(done.fetch_add(1, Ordering::Relaxed) + 1, total, "page")?;
        Ok(p)
    };
    #[cfg(feature = "parallel")]
    let got: Result<Vec<_>, String> = {
        use rayon::prelude::*;
        srcs.par_iter().map(one).collect()
    };
    #[cfg(not(feature = "parallel"))]
    let got: Result<Vec<_>, String> = srcs.iter().map(one).collect();
    Ok(got?.into_iter().flatten().collect())
}

fn jianpu(doc: &Doc, srcs: Vec<(usize, PageSource)>, ocr: &CachedOcr, hook: &Hook) -> Result<Recognition, String> {
    // 没有内嵌图的纯矢量页（转曲简谱）走对象库证据，底图按同一缩放渲出来拼起
    if srcs.iter().all(|s| s.1.raster.is_none()) && srcs.iter().any(|s| s.1.content.is_some()) {
        let idx: Vec<usize> = srcs.iter().filter(|s| s.1.content.is_some()).map(|s| s.0).collect();
        let pcs: Vec<_> = srcs.into_iter().filter_map(|s| s.1.content).collect();
        let score = dolce_omr_jianpu::recognize_vector_hooked(&pcs, ocr, hook)?;
        let width = pcs.iter().map(|p| p.width).fold(0.0, f64::max);
        let grays = idx.iter().map(|&i| doc.render(i, dolce_omr_jianpu::vector::PAGE_W / width).map(|r| gray_of(&r))).collect::<Result<Vec<_>, _>>()?;
        return Ok(Recognition::Jianpu { score, binary: stack(&grays) });
    }
    let key = raster_key(&srcs);
    let prep = match memo_jianpu(doc, &srcs) {
        Some(p) => p,
        None => {
            let imgs: Vec<SourceImage> = srcs.into_iter().filter_map(|s| s.1.raster).collect();
            let p = Arc::new(dolce_omr_jianpu::prepare(&imgs)?);
            if let Ok(mut m) = doc.memo.jianpu.lock() {
                *m = Some((key, p.clone()));
            }
            p
        }
    };
    let (score, binary) = dolce_omr_jianpu::recognize_prepared(&prep, ocr, hook)?;
    Ok(Recognition::Jianpu { score, binary })
}

/// 几页灰度图上下拼起再二值化（矢量简谱的底图）。
fn stack(pages: &[Gray]) -> Binary {
    let w = pages.iter().map(|g| g.w).max().unwrap_or(1);
    let h: usize = pages.iter().map(|g| g.h).sum::<usize>().max(1);
    let mut all = vec![255u8; w * h];
    let mut y0 = 0;
    for g in pages {
        for y in 0..g.h {
            all[(y0 + y) * w..(y0 + y) * w + g.w].copy_from_slice(&g.data[y * g.w..(y + 1) * g.w]);
        }
        y0 += g.h;
    }
    binarize(&all, w, h)
}

/// 纯矢量页的核对底图每点几像素（核对 JSON 里矢量页的坐标是 PDF 点）。
pub const VECTOR_OVERLAY_SCALE: f64 = 2.0;

/// 核对底图在页上的位置：位图页是内嵌原图那一块（点，左上原点），纯矢量页是整页。编辑器拿它把整页渲染图摆到底图坐标里。
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Placement {
    /// 底图在页面上占的框（点）
    pub rect: dolce_omr_core::image::Rect,
    /// 页面尺寸（点；图片输入是像素）
    pub page_w: f64,
    pub page_h: f64,
}

/// 一页的灰度原图、「核对坐标 → 这张图像素」的倍数与它在页上的位置：位图页是内嵌原图（原分辨率，倍数 1），纯矢量页按 [`VECTOR_OVERLAY_SCALE`] 渲整页。
fn review_gray(doc: &Doc, page: usize) -> Result<(Gray, f64, Placement), String> {
    let src = doc.source(page)?;
    if let Some(r) = src.raster {
        let at = Placement { rect: r.rect, page_w: r.page_w, page_h: r.page_h };
        return Ok((Gray { w: r.w, h: r.h, data: r.gray }, 1.0, at));
    }
    let (pw, ph) = doc.page_size(page)?;
    let at = Placement { rect: dolce_omr_core::image::Rect::new(0.0, 0.0, pw, ph), page_w: pw, page_h: ph };
    Ok((gray_of(&doc.render(page, VECTOR_OVERLAY_SCALE)?), VECTOR_OVERLAY_SCALE, at))
}

/// 五线谱核对视图的底图、倍数（核对 JSON 的坐标乘它是底图像素；交 web 适配器当页的 `scale`）与它在页上的位置。
pub fn staff_binary(doc: &Doc, page: usize) -> Result<(Binary, f64, Placement), String> {
    let (g, k, at) = review_gray(doc, page)?;
    Ok((binarize(&g.data, g.w, g.h), k, at))
}

/// 五线谱会话的当前产物：带识别 id 的 MusicXML 与核对 JSON。
pub fn staff_output(session: &Session) -> (String, String) {
    (session.song().score.to_musicxml(), session.review_json())
}

/// 识别用的二值图打成字节：前 8 字节宽高（小端 u32），其后每像素一字节 0 / 1。
pub fn binary_bytes(b: &Binary) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + b.data.len());
    out.extend_from_slice(&(b.w as u32).to_le_bytes());
    out.extend_from_slice(&(b.h as u32).to_le_bytes());
    out.extend_from_slice(&b.data);
    out
}

/// 点原图补认：第 `pi` 个结果页（`pages[pi]` 是它在文档里的页号）上的点 (x, y)（核对坐标）落到最近的一行谱，
/// 在原图上开窗按模板找头（[`dolce_omr_staff::notes::head_near`]），找不到就按点的位置造一个四分音符；交会话补音，回新音的识别 id。
pub fn insert(doc: &Doc, session: &mut Session, pages: &[usize], pi: usize, x: f64, y: f64) -> Result<dolce_omr_sheet::result::Rid, String> {
    use dolce_omr_staff::notes::heads::HeadKind;
    use dolce_omr_staff::song::NewNote;
    let page = session.pages().get(pi).ok_or("没有这一页")?;
    let up = page.layout.up;
    let (wx, wy) = (x * up, y * up);
    // 最近的一行谱：点到谱表上下沿的距离（在谱表里为 0），按线距折算，至多 6 格
    let si = page
        .layout
        .staves
        .iter()
        .enumerate()
        .map(|(i, s)| (i, ((s.top(wx) - wy).max(wy - s.bottom(wx)).max(0.0)) / s.space()))
        .filter(|&(_, d)| d <= 6.0)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|p| p.0)
        .ok_or("点不在任何一行谱附近")?;
    let st = &page.layout.staves[si];
    let found = if page.layout.vector {
        None
    } else {
        let src = doc.source(*pages.get(pi).ok_or("没有这一页")?)?;
        src.raster.as_ref().and_then(|r| dolce_omr_staff::page::frame_page(r, None)).and_then(|f| dolce_omr_staff::notes::head_near(&f, &page.attrs, si, wx, wy))
    };
    let note = match found {
        Some((h, stem, tails)) => NewNote { page: pi, staff: si, x: h.x, y: h.y, pos: h.pos, kind: h.kind, tails, dots: 0, stem },
        None => {
            let pos = st.pos(wx, wy).round() as i32;
            NewNote { page: pi, staff: si, x: wx, y: st.y_of(wx, pos as f64), pos, kind: HeadKind::Filled, tails: 0, dots: 0, stem: None }
        }
    };
    session.apply(dolce_omr_staff::session::Op::Add { note })?;
    session.last_added().ok_or_else(|| "补音没记上".into())
}

/// 框选重认读成哪一类。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegionClass {
    Lyric,
    Text,
}

/// 框选重认：第 `pi` 个结果页上的框（核对坐标 x, y, w, h）裁出来读一行字。
/// 歌词：框里原有的歌词字按 x 分字（汉字一字一个，拉丁词一词一个，标点随前一个）给最近的那个；文字：框里第一条文字指示换成整串。
/// 只换已有元素的文字（框里没有歌词 / 文字指示回 Err）；回换了几个。
pub fn region(doc: &Doc, session: &mut Session, pages: &[usize], pi: usize, rect: dolce_omr_core::image::Rect, class: RegionClass, ocr: &CachedOcr) -> Result<usize, String> {
    use dolce_omr_sheet::score::Dir;
    let (g, k, _) = review_gray(doc, *pages.get(pi).ok_or("没有这一页")?)?;
    let (x0, y0) = ((rect.x * k).floor().max(0.0) as usize, (rect.y * k).floor().max(0.0) as usize);
    let (x1, y1) = ((((rect.x + rect.w) * k).ceil() as usize).min(g.w), (((rect.y + rect.h) * k).ceil() as usize).min(g.h));
    if x1 <= x0 + 2 || y1 <= y0 + 2 {
        return Err("框太小".into());
    }
    let strip = Gray { w: x1 - x0, h: y1 - y0, data: (y0..y1).flat_map(|y| g.data[y * g.w + x0..y * g.w + x1].iter().copied()).collect() };
    let chars = ocr.read_line(&strip)?;
    let inside = |at: Option<dolce_omr_sheet::result::SrcBox>| at.filter(|a| a.page == pi + 1).map(|a| (a.rect.x + a.rect.w / 2.0, a.rect.y + a.rect.h / 2.0)).filter(|&(cx, cy)| cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h);
    let score = &session.song().score;
    let events = || score.parts.iter().flat_map(|p| p.measures.iter()).flat_map(|m| m.events.iter());
    let mut ops = Vec::new();
    match class {
        RegionClass::Lyric => {
            let mut targets: Vec<(f64, dolce_omr_sheet::result::Rid)> =
                events().flat_map(|e| e.lyrics.iter()).filter_map(|l| Some((inside(l.src.at)?.0, l.src.rid?))).collect();
            if targets.is_empty() {
                return Err("框里没有歌词".into());
            }
            targets.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut got: Vec<String> = vec![String::new(); targets.len()];
            for (text, cx) in tokens(&chars) {
                let x = rect.x + cx * rect.w;
                let t = (0..targets.len()).min_by(|&a, &b| (targets[a].0 - x).abs().total_cmp(&(targets[b].0 - x).abs())).unwrap();
                got[t].push_str(&text);
            }
            for (t, text) in targets.iter().zip(got) {
                if !text.is_empty() {
                    ops.push((t.1, text));
                }
            }
        }
        RegionClass::Text => {
            let rid = events()
                .flat_map(|e| e.pre.iter())
                .filter(|d| matches!(d.dir, Dir::Words { .. }))
                .find_map(|d| inside(d.src.at).and(d.src.rid))
                .ok_or("框里没有文字指示")?;
            let text: String = chars.iter().map(|c| c.ch.as_str()).collect::<String>().trim().to_string();
            ops.push((rid, text));
        }
    }
    let n = ops.len();
    for (rid, text) in ops {
        session.apply(dolce_omr_staff::session::Op::Text { rid, text })?;
    }
    Ok(n)
}

/// 读出的一行字切成分给音的单位：汉字一字一个，拉丁字母连成的词一个，标点随前一个；空格只作分隔。回 (字串, 中心占条宽的比例)。
fn tokens(chars: &[dolce_omr_ocr::CharPos]) -> Vec<(String, f64)> {
    let mut out: Vec<(String, f64, f64)> = Vec::new();
    let mut prev_latin = false;
    for c in chars {
        let ch = c.ch.chars().next().unwrap_or(' ');
        if ch.is_whitespace() {
            prev_latin = false;
            continue;
        }
        let latin = ch.is_ascii_alphanumeric() || ch == '\'' || ch == '-';
        let punct = !latin && !ch.is_alphanumeric();
        match out.last_mut() {
            Some(t) if punct || (latin && prev_latin) => {
                t.0.push_str(&c.ch);
                t.2 = c.x1;
            }
            _ => out.push((c.ch.clone(), c.x0, c.x1)),
        }
        prev_latin = latin;
    }
    out.into_iter().map(|(s, a, b)| (s, (a + b) / 2.0)).collect()
}
