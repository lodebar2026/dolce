//! SVG path `d` 的紧包围盒，照 `src/common/pathbounds.ts`：曲线按极值点算（不含控制点），同浏览器 `getBBox()`。
//! 支持 M L H V C S Q T Z（含相对写法）；A 只计端点（页面树不产生弧）。算式次序与 TS 相同，结果逐位一致。

use super::Rect;

/// 三次 / 二次贝塞尔一个坐标分量在 (0,1) 内的极值参数。
fn cubic_extrema(p0: f64, p1: f64, p2: f64, p3: f64) -> Vec<f64> {
    let a = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
    let b = 2.0 * (p0 - 2.0 * p1 + p2);
    let c = p1 - p0;
    let mut ts = Vec::with_capacity(2);
    if a.abs() < 1e-12 {
        if b.abs() > 1e-12 {
            ts.push(-c / b);
        }
    } else {
        let disc = b * b - 4.0 * a * c;
        if disc >= 0.0 {
            let s = disc.sqrt();
            ts.push((-b + s) / (2.0 * a));
            ts.push((-b - s) / (2.0 * a));
        }
    }
    ts.retain(|&t| t > 0.0 && t < 1.0);
    ts
}

fn cubic_at(p0: f64, p1: f64, p2: f64, p3: f64, t: f64) -> f64 {
    let u = 1.0 - t;
    u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3
}

fn is_cmd(c: u8) -> bool {
    matches!(c.to_ascii_uppercase(), b'M' | b'L' | b'H' | b'V' | b'C' | b'S' | b'Q' | b'T' | b'A' | b'Z')
}

/// 一段参数串里的数（同 TS 的 `/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g`）。
fn numbers(s: &[u8]) -> Vec<f64> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < s.len() {
        let start = i;
        let mut j = i;
        if j < s.len() && (s[j] == b'+' || s[j] == b'-') {
            j += 1;
        }
        let digits = |k: &mut usize| {
            let b = *k;
            while *k < s.len() && s[*k].is_ascii_digit() {
                *k += 1;
            }
            *k > b
        };
        let mut k = j;
        let ok = if digits(&mut k) {
            if k < s.len() && s[k] == b'.' {
                k += 1;
                digits(&mut k);
            }
            true
        } else if k < s.len() && s[k] == b'.' {
            k += 1;
            digits(&mut k)
        } else {
            false
        };
        if !ok {
            i = start + 1;
            continue;
        }
        // 指数部分：要有数字才算
        if k < s.len() && (s[k] == b'e' || s[k] == b'E') {
            let mut e = k + 1;
            if e < s.len() && (s[e] == b'+' || s[e] == b'-') {
                e += 1;
            }
            if digits(&mut e) {
                k = e;
            }
        }
        let txt = std::str::from_utf8(&s[start..k]).unwrap_or("0");
        out.push(txt.parse::<f64>().unwrap_or(f64::NAN));
        i = k;
    }
    out
}

struct Acc {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl Acc {
    fn add(&mut self, x: f64, y: f64) {
        if x < self.x0 {
            self.x0 = x;
        }
        if x > self.x1 {
            self.x1 = x;
        }
        if y < self.y0 {
            self.y0 = y;
        }
        if y > self.y1 {
            self.y1 = y;
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn cubic(&mut self, ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, dx: f64, dy: f64) {
        self.add(dx, dy);
        for t in cubic_extrema(ax, bx, cx, dx) {
            self.add(cubic_at(ax, bx, cx, dx, t), cubic_at(ay, by, cy, dy, t));
        }
        for t in cubic_extrema(ay, by, cy, dy) {
            self.add(cubic_at(ax, bx, cx, dx, t), cubic_at(ay, by, cy, dy, t));
        }
    }
}

pub fn path_bounds(d: &str) -> Rect {
    let mut acc = Acc { x0: f64::INFINITY, y0: f64::INFINITY, x1: f64::NEG_INFINITY, y1: f64::NEG_INFINITY };
    let (mut cx, mut cy, mut sx, mut sy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut qx, mut qy) = (0.0f64, 0.0f64);
    let mut prev = b' ';
    let bytes = d.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !is_cmd(bytes[i]) {
            i += 1;
            continue;
        }
        let op = bytes[i];
        let mut j = i + 1;
        while j < bytes.len() && !is_cmd(bytes[j]) {
            j += 1;
        }
        let args = numbers(&bytes[i + 1..j]);
        i = j;
        let rel = op.is_ascii_lowercase();
        let up = op.to_ascii_uppercase();
        if up == b'Z' {
            cx = sx;
            cy = sy;
            prev = b'Z';
            continue;
        }
        let arity = match up {
            b'M' | b'L' | b'T' => 2,
            b'H' | b'V' => 1,
            b'C' => 6,
            b'S' | b'Q' => 4,
            _ => 7, // A
        };
        let mut k = 0;
        while k + arity <= args.len() {
            let a = &args[k..k + arity];
            let (ox, oy) = if rel { (cx, cy) } else { (0.0, 0.0) };
            let cmd = if up == b'M' && k > 0 { b'L' } else { up };
            match cmd {
                b'M' => {
                    cx = a[0] + ox;
                    sx = cx;
                    cy = a[1] + oy;
                    sy = cy;
                    acc.add(cx, cy);
                }
                b'L' => {
                    cx = a[0] + ox;
                    cy = a[1] + oy;
                    acc.add(cx, cy);
                }
                b'H' => {
                    cx = a[0] + ox;
                    acc.add(cx, cy);
                }
                b'V' => {
                    cy = a[0] + oy;
                    acc.add(cx, cy);
                }
                b'C' => {
                    let (x1, y1, x2, y2, x, y) = (a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy, a[4] + ox, a[5] + oy);
                    acc.cubic(cx, cy, x1, y1, x2, y2, x, y);
                    qx = x2;
                    qy = y2;
                    cx = x;
                    cy = y;
                }
                b'S' => {
                    let refl = prev == b'C' || prev == b'S';
                    let rx = if refl { 2.0 * cx - qx } else { cx };
                    let ry = if refl { 2.0 * cy - qy } else { cy };
                    let (x2, y2, x, y) = (a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy);
                    acc.cubic(cx, cy, rx, ry, x2, y2, x, y);
                    qx = x2;
                    qy = y2;
                    cx = x;
                    cy = y;
                }
                b'Q' | b'T' => {
                    let (px, py, x, y);
                    if cmd == b'Q' {
                        (px, py, x, y) = (a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy);
                    } else {
                        let refl = prev == b'Q' || prev == b'T';
                        px = if refl { 2.0 * cx - qx } else { cx };
                        py = if refl { 2.0 * cy - qy } else { cy };
                        (x, y) = (a[0] + ox, a[1] + oy);
                    }
                    // 二次升三次
                    acc.cubic(
                        cx,
                        cy,
                        cx + (2.0 / 3.0) * (px - cx),
                        cy + (2.0 / 3.0) * (py - cy),
                        x + (2.0 / 3.0) * (px - x),
                        y + (2.0 / 3.0) * (py - y),
                        x,
                        y,
                    );
                    qx = px;
                    qy = py;
                    cx = x;
                    cy = y;
                }
                _ => {
                    cx = a[5] + ox;
                    cy = a[6] + oy;
                    acc.add(cx, cy);
                }
            }
            prev = cmd;
            k += arity;
        }
    }
    if acc.x1 < acc.x0 {
        return Rect::default();
    }
    Rect::new(acc.x0, acc.y0, acc.x1, acc.y1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basics() {
        assert_eq!(path_bounds(""), Rect::default());
        assert_eq!(path_bounds("M1 2 L3 4 Z"), Rect::new(1.0, 2.0, 3.0, 4.0));
        assert_eq!(path_bounds("M0 0 l3-4 h2 v-1"), Rect::new(0.0, -5.0, 5.0, 0.0));
        // 曲线不含控制点：顶在 t=0.5 处 = 0.75 × 控制点高
        let r = path_bounds("M0 0 C0 -4 10 -4 10 0");
        assert_eq!((r.left, r.right, r.bottom), (0.0, 10.0, 0.0));
        assert!((r.top + 3.0).abs() < 1e-12);
        assert_eq!(numbers(b"1.5-2e3.5 .25 1e"), vec![1.5, -2000.0, 0.5, 0.25, 1.0]);
        // M 后面的成对坐标按 L 读
        assert_eq!(path_bounds("M0 0 5 5"), Rect::new(0.0, 0.0, 5.0, 5.0));
    }
}
