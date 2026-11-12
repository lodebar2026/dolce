//! 转曲矢量歌本逐首识别的取数：每首按摆放的各段**回原书取矢量对象**（不认渲出来的图）。识别本身在 `omr-cli`（走五线谱 / 混排路线），
//! 这里只交每段的页号与裁框，免得本 crate 依赖识别路线。对应 web `omr/booksplit/recognize.ts`。
use crate::source::SCAN_DPI;
use crate::BookPlan;
use dolce_omr_core::image::Rect;

/// 一首里的一段：页（源序号）、裁框与要剔掉的框（页码），页面点。
pub struct SongClip {
    pub page: usize,
    pub rect: Rect,
    pub drop: Vec<Rect>,
}

/// 第 `k` 首的各段。横向不裁（版心外的曲号、页边小字不碍事），纵向照摆放拷的那一段；扫描像素按 [`SCAN_DPI`] 换回点。
pub fn song_clips(plan: &BookPlan, k: usize) -> Vec<SongClip> {
    let s = 72.0 / SCAN_DPI;
    let pt = |r: &Rect| Rect::new(r.x * s, r.y * s, r.w * s, r.h * s);
    plan.layouts[k]
        .parts
        .iter()
        .map(|part| {
            let p = &plan.pages[part.page];
            SongClip {
                page: part.page,
                rect: pt(&Rect::new(0.0, part.src.y, p.layout.w, part.src.h)),
                drop: p.footer.iter().map(pt).collect(),
            }
        })
        .collect()
}
