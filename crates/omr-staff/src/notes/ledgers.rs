//! **加线**：谱表外的头的证据。实心种子、空心头的孔两路共用同一个判据（[`ledger_ok`]）。
use super::heads::Head;
use crate::frame::ink::INK;
use crate::page::PageFrame;

/// 谱表外的头要有加线作证：从谱表到头之间的**每一条**加线位置上，头的左边或右边都伸出一截细横墨
/// （纵向不比谱线厚多少）。歌词、标题里的笔画凑不齐这一串。`half_w`：头的半宽（像素）。
pub fn ledger_ok(f: &PageFrame, h: &Head, half_w: f64) -> bool {
    if (-1..=9).contains(&h.pos) {
        return true;
    }
    let s = &f.staves[h.staff];
    let sp = s.space();
    let last = if h.pos < 0 { h.pos + (h.pos & 1) } else { h.pos - (h.pos & 1) };
    let slack = ((0.15 * sp).round() as i64).max(1);
    let max_t = (f.unit.thick * 2.0).ceil() as i64 + 1;
    let (a, b) = ((half_w + 0.05 * sp).round() as i64, (half_w + 0.3 * sp).round() as i64);
    let x = h.x.round() as i64;
    // (px, py) 处是细横墨：有墨，所在纵向墨段不厚
    let thin = |px: i64, py: i64| {
        if f.ink.at(px, py) != INK {
            return false;
        }
        let (mut u, mut d) = (py, py);
        while py - u <= max_t && f.ink.at(px, u - 1) == INK {
            u -= 1;
        }
        while d - py <= max_t && f.ink.at(px, d + 1) == INK {
            d += 1;
        }
        d - u + 1 <= max_t
    };
    let lines: Vec<i32> = if h.pos < 0 { (last..=-2).step_by(2).collect() } else { (10..=last).step_by(2).collect() };
    lines.iter().all(|&line| {
        let y = s.y_of(h.x, line as f64).round() as i64;
        [-1, 1].iter().any(|&dir| (a..=b).any(|d| (-slack..=slack).any(|dy| thin(x + dir * d, y + dy))))
    })
}

/// 实心头的半宽（相对线距）：查加线用。
pub const FILLED_HALF_W: f64 = 0.65;

