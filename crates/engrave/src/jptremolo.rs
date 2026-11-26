//! 简谱的同音高震音号（`engrave/jptremolo.ts`，GB/T 46845—2025 7.8.2.1）：左低右高的几道并列短线，记在音符右下角。

/// 一道斜线：下端中点 (x0, y0)、上端中点 (x1, y1)，两端水平截平、水平厚 `thick`。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JpTremoloStroke {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub thick: f64,
}

/// 相对锚点（数字墨迹右缘 / 最后一个附点右缘；y 为数字墨迹中心）的几道斜线与伸出的宽。
pub fn jp_tremolo_strokes(n: usize, h: f64) -> (Vec<JpTremoloStroke>, f64) {
    let thick = h * 0.1;
    let lead = h * 0.45 + thick / 2.0;
    let dx = h * 0.58;
    let rise = h * 0.72;
    let step_x = h * 0.29;
    let step_y = h * 0.23;
    let top = -h / 2.0;
    let mut strokes = Vec::with_capacity(n);
    for i in 0..n {
        let i = i as f64;
        let x0 = lead + i * step_x;
        let y1 = top + i * step_y;
        strokes.push(JpTremoloStroke { x0, y0: y1 + rise, x1: x0 + dx, y1, thick });
    }
    let width = if n > 0 { lead + (n as f64 - 1.0) * step_x + dx + thick / 2.0 } else { 0.0 };
    (strokes, width)
}

/// 记号名 → 震音几道（`trem1`–`trem4`），不是震音为 0。
pub fn jp_tremolo_count(names: &[&str]) -> usize {
    for n in names {
        if let Some(d) = n.strip_prefix("trem") {
            if let Ok(k @ 1..=4) = d.parse::<usize>() {
                if d.len() == 1 {
                    return k;
                }
            }
        }
    }
    0
}
