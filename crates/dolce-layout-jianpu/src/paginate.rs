//! 纵向排版：谱行块 → 页（照 `jianpu/vertical.ts::paginate`）。分页器不认识谱行里有什么，只认每块的占位盒。

/// 一个谱行块的占位盒（相对块原点）
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SystemBlock {
    pub top: f64,
    pub bottom: f64,
    /// 本块必须另起一页
    pub break_before: bool,
}

pub struct PaginateSpec<'a> {
    /// 第 page 页第一块占位盒上缘的 y
    pub page_top: &'a dyn Fn(usize) -> f64,
    /// 占位盒下缘不得超过的 y（`INFINITY` = 不按高度分页）
    pub bottom: f64,
    pub gap: f64,
    /// 放不满的页把行距摊开到 `max_gap` 为止
    pub spread: Option<f64>,
}

/// 把块码进页里：每页一串 (块下标, 块原点 y)
pub fn paginate(blocks: &[SystemBlock], spec: &PaginateSpec) -> Vec<Vec<(usize, f64)>> {
    let mut pages: Vec<Vec<(usize, f64)>> = vec![];
    let mut last_bottom = 0.0;
    for (bi, block) in blocks.iter().enumerate() {
        let h = block.bottom - block.top;
        let mut fresh = pages.is_empty() || block.break_before;
        if !fresh && last_bottom + spec.gap + h > spec.bottom {
            fresh = true;
        }
        if fresh {
            let y = (spec.page_top)(pages.len()) - block.top;
            pages.push(vec![(bi, y)]);
            last_bottom = y + block.bottom;
        } else {
            let y = last_bottom + spec.gap - block.top;
            pages.last_mut().unwrap().push((bi, y));
            last_bottom = y + block.bottom;
        }
    }
    if let Some(max_gap) = spec.spread {
        if spec.bottom.is_finite() {
            for (i, pg) in pages.iter_mut().enumerate() {
                if pg.len() < 2 {
                    continue;
                }
                let top = (spec.page_top)(i);
                let mut total = 0.0;
                for &(b, _) in pg.iter() {
                    total += blocks[b].bottom - blocks[b].top;
                }
                let dd = dolce_model::base::js::min(max_gap, (spec.bottom - top - total) / (pg.len() - 1) as f64);
                let mut y = top;
                for p in pg.iter_mut() {
                    let b = &blocks[p.0];
                    p.1 = y - b.top;
                    y += b.bottom - b.top + dd;
                }
            }
        }
    }
    pages
}
