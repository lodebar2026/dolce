//! 谱表带里的**字形单元**：符号墨块按「横向重叠、上下贴着」并成一个单元（断成几截的谱号、竖笔与肚子分家的降号、上下两个拍号数字），
//! 量它在谱表局部坐标里的上下沿，按列读纵向墨段（数竖笔）。结构信息的各判据都问单元，不直接问墨块。
use crate::frame::ink::{BG, INK};
use crate::page::PageFrame;
use dolce_omr_core::image::Rect;
use dolce_omr_sheet::Staff;

/// 两块横向重叠到窄的那块的这个比例、上下相隔不过 `JOIN_GAP` 格，并成一个单元。
const JOIN_OVERLAP: f64 = 0.5;
const JOIN_GAP: f64 = 0.3;
/// 小于这么大（平方线距）的碎墨不成单元。
const MIN_AREA: f64 = 0.04;
/// 扁到这么矮（格）又宽过 `FLAT_W` 的是加线、连线的一截，不成单元。
const FLAT_H: f64 = 0.3;
const FLAT_W: f64 = 0.6;

/// 一个字形单元。
#[derive(Clone, Debug)]
pub struct Unit {
    pub rect: Rect,
    /// 组成它的墨块标号（`labels` 里的值）。
    pub ids: Vec<i32>,
    /// 上下沿的音级位置（按单元中心 x 处的线位）。
    pub top: f64,
    pub bottom: f64,
    pub area: f64,
}

impl Unit {
    /// 宽、高（线距）。
    pub fn w(&self, sp: f64) -> f64 {
        self.rect.w / sp
    }
    pub fn h(&self, sp: f64) -> f64 {
        self.rect.h / sp
    }
    pub fn mid(&self) -> f64 {
        (self.top + self.bottom) / 2.0
    }
}

fn unit_of(s: &Staff, rect: Rect, ids: Vec<i32>, area: f64) -> Unit {
    let x = rect.cx();
    Unit { top: s.pos(x, rect.y), bottom: s.pos(x, rect.bottom()), rect, ids, area }
}

/// 两个单元并成一个。
pub fn merged(s: &Staff, a: &Unit, b: &Unit) -> Unit {
    let (x, y) = (a.rect.x.min(b.rect.x), a.rect.y.min(b.rect.y));
    let rect = Rect::new(x, y, a.rect.right().max(b.rect.right()) - x, a.rect.bottom().max(b.rect.bottom()) - y);
    let mut ids = a.ids.clone();
    ids.extend(b.ids.iter().copied());
    unit_of(s, rect, ids, a.area + b.area)
}

/// 一行谱在 [x0, x1] 里、纵向落在音级位置 [pos0, pos1] 一带的单元，按左缘排序。
pub fn units_in(f: &PageFrame, s: &Staff, x0: f64, x1: f64, pos0: f64, pos1: f64) -> Vec<Unit> {
    let sp = s.space();
    let mut us: Vec<Unit> = f
        .blobs
        .iter()
        .filter(|b| {
            let r = &b.rect;
            let x = r.cx();
            x >= x0 && x <= x1 && r.bottom() >= s.y_of(x, pos0) && r.y <= s.y_of(x, pos1) && b.area as f64 >= sp * sp * MIN_AREA && !(r.h < sp * FLAT_H && r.w > sp * FLAT_W)
        })
        .map(|b| unit_of(s, b.rect, vec![b.id as i32], b.area as f64))
        .collect();
    us.sort_by(|a, b| a.rect.x.total_cmp(&b.rect.x));
    // 并碎块：反复并到不动
    loop {
        let mut hit = None;
        'find: for i in 0..us.len() {
            for j in i + 1..us.len() {
                let (a, b) = (&us[i].rect, &us[j].rect);
                let ov = a.right().min(b.right()) - a.x.max(b.x);
                let gap = a.y.max(b.y) - a.bottom().min(b.bottom());
                if ov >= a.w.min(b.w) * JOIN_OVERLAP && gap <= sp * JOIN_GAP {
                    hit = Some((i, j));
                    break 'find;
                }
            }
        }
        let Some((i, j)) = hit else { break };
        let b = us.remove(j);
        us[i] = merged(s, &us[i], &b);
    }
    us.sort_by(|a, b| a.rect.x.total_cmp(&b.rect.x));
    us
}

/// 单元在某一列上的墨：自己那几块的像素（谱线存疑像素夹在自己的墨中间时也算——竖笔穿线处本来就是墨，这里只为不在毛边上断开）。
/// 回 (最上墨行, 最下墨行, 最长纵向墨段长)；这一列没有它的墨回 None。
pub fn column(f: &PageFrame, u: &Unit, x: i64) -> Option<(i64, i64, i64)> {
    if x < 0 || x as usize >= f.ink.w {
        return None;
    }
    let (y0, y1) = (u.rect.y.floor() as i64, (u.rect.bottom().ceil() as i64).min(f.ink.h as i64 - 1));
    let mine = |y: i64| y >= 0 && u.ids.contains(&f.labels[y as usize * f.ink.w + x as usize]);
    let (mut top, mut bot, mut best, mut run) = (None, 0, 0, 0);
    for y in y0..=y1 {
        if mine(y) || (run > 0 && f.ink.at(x, y) != BG && (y + 1..=y + 2).any(mine)) {
            top.get_or_insert(y);
            bot = y;
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    top.map(|t| (t, bot, best))
}

/// 把单元在 x = `cut` 处切成左右两半（并排粘在一起的升降号）：各取自己那半的上下沿。
pub fn split_at(f: &PageFrame, s: &Staff, u: &Unit, cut: f64) -> Option<(Unit, Unit)> {
    let half = |xa: i64, xb: i64| -> Option<Unit> {
        let (mut top, mut bot, mut n) = (i64::MAX, i64::MIN, 0.0);
        for x in xa..=xb {
            if let Some((t, b, _)) = column(f, u, x) {
                top = top.min(t);
                bot = bot.max(b);
                n += (b - t + 1) as f64 * 0.5;
            }
        }
        (bot >= top).then(|| unit_of(s, Rect::new(xa as f64, top as f64, (xb - xa + 1) as f64, (bot - top + 1) as f64), u.ids.clone(), n))
    };
    let c = cut.round() as i64;
    Some((half(u.rect.x.floor() as i64, c - 1)?, half(c, u.rect.right().ceil() as i64 - 1)?))
}

/// 单元里的通高竖笔：纵向墨段不短于单元高的 `frac` 的那些列，相邻列并成一根。回每根的 (左列, 右列, 上端, 下端)。
pub fn stems(f: &PageFrame, u: &Unit, frac: f64) -> Vec<(i64, i64, i64, i64)> {
    let need = (u.rect.h * frac).max(2.0) as i64;
    let mut out: Vec<(i64, i64, i64, i64)> = Vec::new();
    for x in u.rect.x.floor() as i64..u.rect.right().ceil() as i64 {
        let Some((t, b, run)) = column(f, u, x) else { continue };
        if run < need {
            continue;
        }
        // 取最长那一段的上下端（近似：整列上下沿；列里有两段墨时偏大，够用）
        match out.last_mut() {
            Some(s) if s.1 + 1 >= x => {
                s.1 = x;
                s.2 = s.2.min(t);
                s.3 = s.3.max(b);
            }
            _ => out.push((x, x, t, b)),
        }
    }
    out
}

/// 单元在一个矩形窗里的符号墨像素数（谱线存疑像素不算）。
pub fn ink_in(f: &PageFrame, x0: i64, x1: i64, y0: i64, y1: i64) -> usize {
    let mut n = 0;
    for y in y0..=y1 {
        for x in x0..=x1 {
            n += (f.ink.at(x, y) == INK) as usize;
        }
    }
    n
}

/// 一根竖笔：横跨 [x0, x1] 列，纵向 [top, bottom]（各列的中位）。
#[derive(Clone, Copy, Debug)]
pub struct Stroke {
    pub x0: i64,
    pub x1: i64,
    pub top: i64,
    pub bottom: i64,
}

impl Stroke {
    pub fn cx(&self) -> f64 {
        (self.x0 + self.x1) as f64 / 2.0
    }
    pub fn len(&self) -> i64 {
        self.bottom - self.top + 1
    }
}

/// 窗里的竖笔：逐列的纵向墨段（谱线存疑像素也算墨——竖笔穿线处连着）长在 [min_len, max_len] 之间的，
/// 相邻列上下端都差不多（各差不过 `min_len` 的四分之一）的连成一根；宽过 `max_w` 的不是竖笔。按 x 排好。
pub fn strokes(f: &PageFrame, x0: i64, x1: i64, y0: i64, y1: i64, min_len: i64, max_len: i64, max_w: i64) -> Vec<Stroke> {
    let tol = (min_len / 4).max(2);
    let gap = (min_len / 18).max(2);
    let mut open: Vec<(Stroke, Vec<i64>, Vec<i64>)> = Vec::new();
    let mut done: Vec<Stroke> = Vec::new();
    let close = |s: (Stroke, Vec<i64>, Vec<i64>), done: &mut Vec<Stroke>| {
        let (mut st, mut t, mut b) = s;
        t.sort();
        b.sort();
        st.top = t[t.len() / 2];
        st.bottom = b[b.len() / 2];
        if st.x1 - st.x0 + 1 <= max_w {
            done.push(st);
        }
    };
    for x in x0..=x1 + 1 {
        let mut runs: Vec<(i64, i64)> = Vec::new();
        if x <= x1 {
            let mut y = y0;
            while y <= y1 {
                if f.ink.at(x, y) == BG {
                    y += 1;
                    continue;
                }
                let a = y;
                loop {
                    while y <= y1 && f.ink.at(x, y) != BG {
                        y += 1;
                    }
                    // 一两像素的白缝接上（扫描件的细竖笔常断一截）
                    match (y..=(y + gap).min(y1)).find(|&yy| f.ink.at(x, yy) != BG) {
                        Some(yy) if yy > y => y = yy,
                        _ => break,
                    }
                }
                // 顶到窗口上下沿的不知有多长，不收
                if y - a >= min_len && y - a <= max_len && a > y0 && y <= y1 {
                    runs.push((a, y - 1));
                }
            }
        }
        let mut next = Vec::new();
        for (a, b) in runs {
            match open.iter().position(|s| s.0.x1 + 1 == x && (*s.1.last().unwrap() - a).abs() <= tol && (*s.2.last().unwrap() - b).abs() <= tol) {
                Some(i) => {
                    let mut s = open.swap_remove(i);
                    s.0.x1 = x;
                    s.1.push(a);
                    s.2.push(b);
                    next.push(s);
                }
                None => next.push((Stroke { x0: x, x1: x, top: a, bottom: b }, vec![a], vec![b])),
            }
        }
        for s in open.drain(..) {
            close(s, &mut done);
        }
        open = next;
    }
    done.sort_by_key(|s| s.x0);
    done
}
