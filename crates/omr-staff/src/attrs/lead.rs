//! **行首区**：每行谱开头按次序认谱号 → 调号 → 拍号。
//!
//! - 谱号按单元上下沿在谱表上的位置分（高音谱号上下都探出谱表、低音谱号从第五线挂到第二线一带且右边有两点、
//!   中音谱号正好撑满谱表且左边两根竖笔），不比模板。
//! - 调号按**位置自证**：谱号定了，第 i 个升号 / 降号该在哪条线、哪个间是定的；单元挨个往右接，位置对得上、形状不矛盾的才算。
//! - 拍号：上下两个数字正好各占半个谱表，数字交给 OCR；C / ¢ 骑在中线上。
use super::units::{ink_in, merged, split_at, stems, strokes, units_in, Unit};
use super::{DigitReader, RowAttrs};
use crate::page::PageFrame;
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::surface::Gray;
use dolce_omr_sheet::music::{Clef, Key, Time, TimeSymbol};
use dolce_omr_sheet::Staff;

/// 行首区找单元的范围（相对谱行左端，格）。
const LEAD_FROM: f64 = -0.5;
const LEAD_TO: f64 = 18.0;
/// 谱号要在左端这么多格以内起头。
const CLEF_WITHIN: f64 = 4.0;
/// 调号第一个记号离谱号、后面每个离前一个的最大空隙（格）。低音谱号的两点之后到第一个记号实测近 1.8 格。
const KEY_GAP_FIRST: f64 = 2.2;
const KEY_GAP: f64 = 1.5;
/// 调号记号的位置容差（音级位置，半格为 1）。
const KEY_POS_TOL: f64 = 0.85;
/// 拍号离前一个单元的最大空隙（格）。
const TIME_GAP: f64 = 3.0;

/// 升降号的形状。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Acc {
    Sharp,
    Flat,
    Natural,
}

/// 单元像不像一个升降还原号（按尺寸）。
pub fn acc_sized(u: &Unit, sp: f64) -> bool {
    let (w, h) = (u.w(sp), u.h(sp));
    (1.6..=3.7).contains(&h) && (0.35..=1.45).contains(&w) && w <= h * 0.7
}

/// 按竖笔认升降还原号：两根近乎通高的竖笔是升号；两根错开（左边那根顶着上沿、右边那根踩着下沿）是还原号；
/// 只有左边一根通高竖笔、右下挂着肚子是降号。看不出回 None。
pub fn acc_kind(f: &PageFrame, u: &Unit, sp: f64) -> Option<Acc> {
    if !acc_sized(u, sp) {
        return None;
    }
    let (x0, x1) = (u.rect.x, u.rect.right());
    let (y0, y1, h) = (u.rect.y, u.rect.bottom(), u.rect.h);
    // 近乎通高的竖笔：升号两根（各占高的八成多），降号一根（顶天立地）；降号肚子、还原号的竖笔都不到七成
    let tall = stems(f, u, 0.72);
    if tall.len() >= 2 && ((tall[tall.len() - 1].0 - tall[0].1) as f64) >= sp * 0.15 {
        return Some(Acc::Sharp);
    }
    if tall.len() == 1 {
        let s = tall[0];
        // 竖笔在左边、顶到上沿；右下有墨、右上没有
        let left = (s.0 as f64 + s.1 as f64) / 2.0 < x0 + u.rect.w * 0.4;
        if !left || ((s.3 - s.2 + 1) as f64) < h * 0.85 {
            return None;
        }
        let (xa, xb) = (s.1 + 1, x1.ceil() as i64 - 1);
        if xb < xa {
            return None;
        }
        let ym = (y0 + h * 0.45) as i64;
        let up = ink_in(f, xa, xb, y0 as i64, ym);
        let down = ink_in(f, xa, xb, ym + 1, y1 as i64);
        return (down > up * 2 && down as f64 >= sp * sp * 0.08).then_some(Acc::Flat);
    }
    // 还原号：两根错开的竖笔，左笔顶着上沿、下端离下沿远，右笔相反；两边没有探出去的横杠
    let st = stems(f, u, 0.5);
    if st.len() < 2 {
        return None;
    }
    let (a, b) = (st[0], st[st.len() - 1]);
    if ((b.0 - a.1) as f64) < sp * 0.15 {
        return None;
    }
    let a_short = (y1 - a.3 as f64) > h * 0.2 && (a.2 as f64 - y0) < h * 0.12;
    let b_short = (b.2 as f64 - y0) > h * 0.2 && (y1 - b.3 as f64) < h * 0.12;
    let out = ink_in(f, x0 as i64, a.0 - 1, y0 as i64, y1 as i64) + ink_in(f, b.1 + 1, x1 as i64, y0 as i64, y1 as i64);
    (a_short && b_short && (out as f64) < sp * sp * 0.06).then_some(Acc::Natural)
}

/// 升降号在谱表上「指着」的音级位置：升号、还原号是中心，降号是肚子的中心（下沿往上半格）。
pub fn acc_pos(u: &Unit, kind: Acc) -> f64 {
    match kind {
        Acc::Flat => u.bottom - 1.0,
        _ => u.mid(),
    }
}

/// 认出的谱号。
pub struct ClefHit {
    pub clef: Clef,
    pub sure: bool,
    pub rect: Rect,
    /// 谱号（连低音谱号的两点）右缘。
    pub right: f64,
    /// 用掉了前几个单元。
    pub used: usize,
}

/// 单元按上下沿位置判谱号种类。回 (谱号, 把握大)。
pub fn clef_shape(f: &PageFrame, u: &Unit, sp: f64) -> Option<(Clef, bool)> {
    let (w, h) = (u.w(sp), u.h(sp));
    if !(1.8..=10.5).contains(&h) || !(0.8..=4.0).contains(&w) {
        return None;
    }
    if u.top <= -1.0 && u.bottom >= 8.8 && h >= 5.0 {
        let sure = (1.9..=3.5).contains(&w) && u.top <= -1.8 && u.bottom >= 9.6;
        // 下面挂着 8（连成一块的）
        let clef = if u.bottom >= 12.6 { Clef::TREBLE_8VB } else { Clef::TREBLE };
        return Some((clef, sure));
    }
    if (-1.2..=1.2).contains(&u.top) && (4.6..=7.8).contains(&u.bottom) && w >= 1.3 {
        return Some((Clef::BASS, (2.8..=3.8).contains(&h) && (1.8..=2.9).contains(&w)));
    }
    // 中音 / 次中音谱号：高四格、左边一粗一细两根通高竖笔
    if (3.6..=4.5).contains(&h) && (1.8..=3.4).contains(&w) {
        let st = stems(f, u, 0.85);
        let left2 = st.len() >= 2 && (st[1].1 as f64) < u.rect.x + u.rect.w * 0.5;
        if left2 {
            if (u.top - 0.0).abs() <= 0.8 {
                return Some((Clef::ALTO, true));
            }
            if (u.top + 2.0).abs() <= 0.8 {
                return Some((Clef::TENOR, true));
            }
        }
    }
    None
}

/// 行首谱号。`us`：行首区的单元（按左缘排）。
pub fn read_clef(f: &PageFrame, s: &Staff, us: &[Unit]) -> Option<ClefHit> {
    let sp = s.space();
    for (i, u) in us.iter().enumerate() {
        if u.rect.x > s.left + sp * CLEF_WITHIN {
            break;
        }
        // 系统线、括号：贴着左端的细长竖笔，或整个在左端以左
        if u.rect.right() < s.left + sp * 0.5 || u.rect.x < s.left - sp * 0.3 || (u.w(sp) < 0.5 && u.h(sp) >= 3.0) {
            continue;
        }
        // 断成几截的谱号（压在谱线上的细弧只剩存疑像素，上半截与下半截分了家）：横向挨着、纵向交叠的碎块并进来再判。
        // 低音谱号的两点、隔着空隙的第一个调号记号不并
        let mut whole = u.clone();
        let mut used = i + 1;
        if u.h(sp) >= 1.2 {
            for (j, v) in us.iter().enumerate().skip(i + 1) {
                let tiny = v.h(sp) < 0.8 && v.w(sp) < 0.8;
                let near = v.rect.x <= whole.rect.right() + sp * 0.12;
                let lap = v.rect.y < whole.rect.bottom() && v.rect.bottom() > whole.rect.y;
                if tiny || !near || !lap || v.rect.right().max(whole.rect.right()) - whole.rect.x > sp * 3.3 || v.h(sp) > 10.5 {
                    continue;
                }
                whole = merged(s, &whole, v);
                used = used.max(j + 1);
            }
        }
        let u = &whole;
        let Some((mut clef, mut sure)) = clef_shape(f, u, sp) else { continue };
        let mut right = u.rect.right();
        if clef == Clef::BASS {
            // 右边两点：第四线（位置 2）上下各一
            let dots: Vec<(usize, &Unit)> = us.iter().enumerate().skip(i + 1).filter(|(_, d)| d.rect.x >= u.rect.x + u.rect.w * 0.6 && d.rect.x <= right + sp * 1.0 && d.w(sp) <= 0.8 && d.h(sp) <= 0.8).collect();
            let up = dots.iter().find(|(_, d)| (d.mid() - 1.0).abs() <= 0.8);
            let down = dots.iter().find(|(_, d)| (d.mid() - 3.0).abs() <= 0.8);
            sure |= up.is_some() && down.is_some();
            for (j, d) in [up, down].into_iter().flatten() {
                right = right.max(d.rect.right());
                used = used.max(j + 1);
            }
        } else if clef == Clef::TREBLE {
            // 下面另有一个小 8
            let eight = us.iter().any(|d| d.rect.cx() >= u.rect.x && d.rect.cx() <= u.rect.right() && d.top >= 10.3 && d.top <= 13.5 && d.bottom <= 15.6 && (0.7..=2.0).contains(&d.h(sp)) && d.w(sp) <= 1.4);
            if eight {
                clef = Clef::TREBLE_8VB;
            }
        }
        // 高音谱号比它该有的宽（宽约为高的 0.38）：右边粘着第一个调号记号，调号从谱号本身的右缘起找
        if clef.sign == dolce_omr_sheet::music::ClefSign::G && u.rect.w > u.rect.h.min(sp * 7.6) * 0.43 {
            right = u.rect.x + u.rect.h.min(sp * 7.6) * 0.38;
        }
        return Some(ClefHit { clef, sure, rect: u.rect, right, used });
    }
    None
}

/// 读出的调号。
pub struct KeyHit {
    pub fifths: i8,
    /// 串收得干净（后面紧跟的不是又一个像升降号却对不上位置的单元）。
    pub sure: bool,
    pub right: f64,
    /// 从 `from` 起用掉了几个单元。
    pub used: usize,
}

/// 调号：从 `us[from..]` 起挨个接。`start`：谱号右缘。
pub fn read_key(f: &PageFrame, s: &Staff, clef: Clef, us: &[Unit], from: usize, start: f64) -> KeyHit {
    let sp = s.space();
    // 降号的竖笔与肚子分了家（肚子只在谱线上连着竖笔，线上那几像素是存疑的）：细竖笔右边紧挨着一个下沿对齐的小块，并回一个
    let mut joined: Vec<Unit> = Vec::new();
    for u in &us[from.min(us.len())..] {
        if let Some(a) = joined.last() {
            let stem = a.w(sp) < 0.45 && (1.5..=3.3).contains(&a.h(sp));
            let bowl = (0.6..=1.7).contains(&u.h(sp)) && (0.3..=1.0).contains(&u.w(sp));
            if stem && bowl && u.rect.x - a.rect.right() <= sp * 0.25 && u.rect.x >= a.rect.x && (u.rect.bottom() - a.rect.bottom()).abs() <= sp * 0.35 {
                let m = merged(s, a, u);
                *joined.last_mut().unwrap() = m;
                continue;
            }
        }
        joined.push(u.clone());
    }
    let (us, from) = (&joined[..], 0usize);
    let mut best = KeyHit { fifths: 0, sure: true, right: start, used: 0 };
    // 纵向不沾谱表的（谱表上方的和弦字、下方的字）不在调号串里
    let on_staff = |u: &Unit| u.bottom >= -3.0 && u.top <= 9.5;
    for sharp in [true, false] {
        let (mut n, mut right, mut used, mut sure) = (0usize, start, 0usize, true);
        let mut j = from;
        while j < us.len() && n < 7 {
            let u = &us[j];
            // 不沾谱表的、碎点（低音谱号的两点、污点）跳过
            if !on_staff(u) || (u.h(sp) < 1.2 && u.w(sp) < 1.0) {
                j += 1;
                continue;
            }
            let gap = if n == 0 { KEY_GAP_FIRST } else { KEY_GAP };
            if u.rect.x - right > sp * gap {
                break;
            }
            // 并排粘成一块的几个：按一个记号一格宽切开
            let parts: Vec<Unit> = if u.w(sp) > 1.5 && u.w(sp) <= 4.5 && (1.6..=6.5).contains(&u.h(sp)) {
                let k = (u.w(sp) / 1.0).round().max(2.0) as usize;
                let mut v = vec![u.clone()];
                for c in 1..k {
                    let last = v.pop().unwrap();
                    match split_at(f, s, &last, u.rect.x + u.rect.w * c as f64 / k as f64) {
                        Some((a, b)) => v.extend([a, b]),
                        None => v.push(last),
                    }
                }
                v
            } else {
                vec![u.clone()]
            };
            let mut ok = true;
            for p in &parts {
                let want = clef.key_pos(sharp, n);
                let kind = acc_kind(f, p, sp);
                let fits = acc_sized(p, sp)
                    && n < 7
                    && want.is_some_and(|w| (acc_pos(p, if sharp { Acc::Sharp } else { Acc::Flat }) - w as f64).abs() <= KEY_POS_TOL)
                    && match kind {
                        Some(Acc::Sharp) => sharp,
                        Some(Acc::Flat) => !sharp,
                        Some(Acc::Natural) => false,
                        None => true,
                    };
                if !fits {
                    ok = false;
                    // 串断在一个紧跟着的单元上：除非它是拍号的模样（撑满谱表，或骑中线的 C），这一串可能没读全
                    let timeish = ((-0.7..=0.9).contains(&u.top) && (7.1..=8.7).contains(&u.bottom) && u.w(sp) <= 2.6) || ((u.mid() - 4.0).abs() <= 0.8 && (1.6..=2.9).contains(&u.h(sp)) && u.top >= 0.6);
                    if !timeish {
                        sure = false;
                    }
                    break;
                }
                if kind.is_none() {
                    sure = false;
                }
                n += 1;
            }
            if !ok {
                break;
            }
            right = u.rect.right();
            j += 1;
            used = j - from;
        }
        if n > best.fifths.unsigned_abs() as usize {
            best = KeyHit { fifths: if sharp { n as i8 } else { -(n as i8) }, sure, right, used };
        } else if n == 0 && best.fifths == 0 {
            best.sure &= sure;
        }
    }
    best
}

/// 调号按**竖笔**读：降号一根竖笔、肚子挂在右下（指着的位置是竖笔下端往上半格）；升号两根并排的竖笔（中心是指着的位置）。
/// 几个记号的墨连成一片、肚子与下一个的竖笔粘着时，按单元读不出来，竖笔照样数得清。回 (升降数, 右缘)。
pub fn read_key_strokes(f: &PageFrame, s: &Staff, clef: Clef, start: f64) -> (i8, f64) {
    let sp = s.space();
    let (x0, x1) = (start.round() as i64, (start + sp * 10.0).round() as i64);
    let xm = (start + sp * 5.0).min(s.right);
    let (y0, y1) = (s.y_of(xm, -5.0).round() as i64, s.y_of(xm, 13.0).round() as i64);
    let st = strokes(f, x0, x1, y0, y1, (sp * 1.5) as i64, (sp * 3.3) as i64, (sp * 0.5).ceil() as i64);
    let mut best = (0i8, start);
    // 降号
    {
        let (mut n, mut right) = (0usize, start);
        for k in &st {
            let gap = if n == 0 { KEY_GAP_FIRST + 0.4 } else { KEY_GAP + 0.2 };
            if k.x0 as f64 - right > sp * gap || n >= 7 {
                break;
            }
            let Some(want) = clef.key_pos(false, n) else { break };
            let p = s.pos(k.cx(), k.bottom as f64) - 1.0;
            // 肚子：竖笔下半截右边有墨，上端右边没有
            let down = ink_in(f, k.x1 + 1, k.x1 + (sp * 0.6) as i64, k.bottom - (sp * 0.9) as i64, k.bottom);
            let up = ink_in(f, k.x1 + 1, k.x1 + (sp * 0.3) as i64, k.top, k.top + (sp * 0.5) as i64);
            // 左边没有东西挂着（符头在干的左下、数字 4 的斜笔在竖笔左边）
            let left = ink_in(f, k.x0 - (sp * 0.5) as i64, k.x0 - 2, k.top + (sp * 0.3) as i64, k.bottom - (sp * 0.2) as i64);
            if (p - want as f64).abs() > KEY_POS_TOL || (down as f64) < sp * sp * 0.08 || up >= down || (left as f64) > sp * sp * 0.05 {
                break;
            }
            n += 1;
            right = k.x1 as f64 + sp * 0.8;
        }
        if n > 0 {
            best = (-(n as i8), right);
        }
    }
    // 升号：两根一对
    {
        let (mut n, mut right) = (0usize, start);
        let mut i = 0;
        while i + 1 < st.len() && n < 7 {
            let (a, b) = (st[i], st[i + 1]);
            let gap = if n == 0 { KEY_GAP_FIRST + 0.4 } else { KEY_GAP + 0.2 };
            if a.x0 as f64 - right > sp * gap {
                break;
            }
            let dx = (b.x0 - a.x1) as f64;
            let ov = (a.bottom.min(b.bottom) - a.top.max(b.top)) as f64;
            let Some(want) = clef.key_pos(true, n) else { break };
            let mid = (s.pos(a.cx(), a.top.min(b.top) as f64) + s.pos(b.cx(), a.bottom.max(b.bottom) as f64)) / 2.0;
            // 两根竖笔之间有横杠连着（两个并排降号的竖笔之间是肚子，只在下半）
            let (ym, q) = ((a.top.max(b.top) + a.bottom.min(b.bottom)) / 2, (sp * 0.25) as i64);
            let bar_up = ink_in(f, a.x1 + 1, b.x0 - 1, a.top.max(b.top), ym - q);
            let bar_down = ink_in(f, a.x1 + 1, b.x0 - 1, ym + q, a.bottom.min(b.bottom));
            let barred = bar_up > 0 && bar_down > 0;
            if !(sp * 0.15..=sp * 0.8).contains(&dx) || ov < a.len().min(b.len()) as f64 * 0.6 || (mid - want as f64).abs() > KEY_POS_TOL || a.len().min(b.len()) as f64 <= sp * 1.7 || !barred {
                break;
            }
            n += 1;
            right = b.x1 as f64 + sp * 0.3;
            i += 2;
        }
        if n > best.0.unsigned_abs() as usize {
            best = (n as i8, right);
        }
    }
    best
}

/// 读出的拍号。
pub struct TimeHit {
    pub time: Option<Time>,
    pub right: f64,
}

/// 把一块符号墨裁成白底黑字的小图（谱线存疑像素当底），四周垫白。
fn cell(f: &PageFrame, x0: i64, x1: i64, y0: i64, y1: i64) -> Gray {
    let pad = ((y1 - y0 + 1) / 5).max(2) as usize;
    let (w, h) = ((x1 - x0 + 1) as usize, (y1 - y0 + 1) as usize);
    let mut g = Gray::new(w + 2 * pad, h + 2 * pad, 255);
    for y in 0..h {
        for x in 0..w {
            if f.ink.at(x0 + x as i64, y0 + y as i64) == crate::frame::ink::INK {
                g.data[(y + pad) * g.w + x + pad] = 0;
            }
        }
    }
    g
}

fn digits_of(s: &str) -> Option<u32> {
    let d: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    if d.is_empty() || d.len() > 2 {
        None
    } else {
        d.parse().ok()
    }
}

/// 上下两个数字 → 拍号。先验：分子读成 8 按 3；分母只能是 2 的幂。
pub fn time_from(top: Option<u32>, bottom: Option<u32>) -> Option<Time> {
    let beats = match top? {
        8 => 3,
        n @ (2..=7 | 9 | 12) => n,
        _ => return None,
    };
    let beat_type = match bottom? {
        n @ (2 | 4 | 8 | 16) => n,
        _ => return None,
    };
    Some(Time { beats: beats as u8, beat_type: beat_type as u8, symbol: TimeSymbol::Normal })
}

/// 一列墨（[x0, x1]）是不是拍号：上下各一个数字、正好各占半个谱表；或骑中线的 C / ¢。
/// `us`：这一列的单元（一个撑满谱表的，或上下两个）。
pub fn read_time_at(f: &PageFrame, s: &Staff, us: &[&Unit], ocr: Option<&dyn DigitReader>) -> Option<TimeHit> {
    let sp = s.space();
    let x0 = us.iter().map(|u| u.rect.x).fold(f64::MAX, f64::min);
    let x1 = us.iter().map(|u| u.rect.right()).fold(f64::MIN, f64::max);
    let top = us.iter().map(|u| u.top).fold(f64::MAX, f64::min);
    let bottom = us.iter().map(|u| u.bottom).fold(f64::MIN, f64::max);
    let w = (x1 - x0) / sp;
    let xc = (x0 + x1) / 2.0;
    if !(0.8..=2.8).contains(&w) {
        return None;
    }
    // C：骑在中线上，高两格出头，不探出谱表
    if (bottom - top) >= 3.2 && (bottom - top) <= 5.6 && ((top + bottom) / 2.0 - 4.0).abs() <= 0.8 && w >= 1.1 && top >= 0.6 {
        // 右边开口：中线下面那半格里，右半几乎没有墨、左半是那道粗弧（上端的圆头常垂到中线，开口在中线以下）
        let (ya, yb) = (s.y_of(xc, 4.25).round() as i64, s.y_of(xc, 5.0).round() as i64);
        let open = ink_in(f, (xc + (x1 - xc) * 0.2) as i64, x1 as i64, ya, yb);
        let closed = ink_in(f, x0 as i64, xc as i64, ya, yb);
        if open * 3 <= closed && closed as f64 >= sp * 0.15 * (yb - ya + 1) as f64 {
            return Some(TimeHit { time: Some(Time { beats: 4, beat_type: 4, symbol: TimeSymbol::Common }), right: x1 });
        }
        return None;
    }
    // 撑满谱表：上沿在首线、下沿在末线（各容一点），中线处一分为二
    if !((-0.7..=0.9).contains(&top) && (7.1..=8.7).contains(&bottom)) {
        return None;
    }
    let ym = s.y_of(xc, 4.0);
    let (ya, yb) = (s.y_of(xc, top).floor() as i64, s.y_of(xc, bottom).ceil() as i64);
    // 上下两半各自都要有像样的墨（一根竖笔撑满谱表的是小节线、符干）
    let half = sp * 0.5;
    let up_ink = ink_in(f, x0 as i64, x1 as i64, ya, (ym - half * 0.3) as i64);
    let down_ink = ink_in(f, x0 as i64, x1 as i64, (ym + half * 0.3) as i64, yb);
    let need = (sp * sp * 0.35) as usize;
    if up_ink < need || down_ink < need {
        return None;
    }
    // ¢：中线一带有一根竖笔穿过、且整体是一块（数字之间隔着中线，中线上只有存疑的线）
    let mid_ink = ink_in(f, x0 as i64, x1 as i64, (ym - sp * 0.12) as i64, (ym + sp * 0.12) as i64);
    let Some(ocr) = ocr else { return Some(TimeHit { time: None, right: x1 }) };
    let a = ocr.read_digit(&cell(f, x0 as i64 - 1, x1 as i64 + 1, ya, ym.round() as i64 - 1));
    let b = ocr.read_digit(&cell(f, x0 as i64 - 1, x1 as i64 + 1, ym.round() as i64 + 1, yb));
    let t = time_from(a.as_deref().and_then(digits_of), b.as_deref().and_then(digits_of));
    if t.is_none() && us.len() == 1 && mid_ink as f64 > sp * 0.24 * sp * 0.15 && top >= -1.6 {
        // 读不成两个数字、中线上又有墨连着：当 ¢（骑中线的 C 加一根竖笔）
        let st = stems(f, us[0], 0.8);
        if st.len() == 1 && w >= 1.1 {
            return Some(TimeHit { time: Some(Time { beats: 2, beat_type: 2, symbol: TimeSymbol::Cut }), right: x1 });
        }
    }
    Some(TimeHit { time: t, right: x1 })
}

/// 行首拍号：`start`（谱号 / 调号右缘）之后紧跟着的那一列。
pub fn read_time(f: &PageFrame, s: &Staff, us: &[Unit], start: f64, ocr: Option<&dyn DigitReader>) -> Option<TimeHit> {
    let sp = s.space();
    let on_staff = |u: &Unit| u.bottom >= -1.5 && u.top <= 9.5 && u.rect.cx() > start && !(u.h(sp) < 1.2 && u.w(sp) < 1.0);
    let u = us.iter().find(|u| on_staff(u))?;
    if u.rect.x - start > sp * TIME_GAP {
        return None;
    }
    // 同一列的其余单元：上下两个数字没并成一个的、C 断成左右两截的（横向挨着不过 0.4 格、合起来不宽过 2.4 格）
    let mut col: Vec<&Unit> = vec![u];
    let (mut xa, mut xb) = (u.rect.x, u.rect.right());
    for v in us.iter().filter(|v| on_staff(v) && !std::ptr::eq(*v, u)) {
        if v.rect.x <= xb + sp * 0.4 && v.rect.right() >= xa - sp * 0.4 && v.rect.right().max(xb) - v.rect.x.min(xa) <= sp * 2.4 {
            xa = xa.min(v.rect.x);
            xb = xb.max(v.rect.right());
            col.push(v);
        }
    }
    read_time_at(f, s, &col, ocr)
}

/// 一行谱的行首区。
pub fn read_lead(f: &PageFrame, s: &Staff, ocr: Option<&dyn DigitReader>) -> RowAttrs {
    let sp = s.space();
    let us = units_in(f, s, s.left + sp * LEAD_FROM, s.left + sp * LEAD_TO, -6.0, 16.0);
    let mut out = RowAttrs { lead_end: s.left, ..Default::default() };
    let (clef, from, mut right) = match read_clef(f, s, &us) {
        Some(c) => {
            out.clef = Some(c.clef);
            out.clef_sure = c.sure;
            out.clef_box = Some(c.rect);
            (c.clef, c.used, c.right)
        }
        None if s.one_line => (Clef::PERCUSSION, 0, s.left),
        None => return out,
    };
    if s.one_line {
        out.clef = Some(Clef::PERCUSSION);
        out.clef_sure = true;
    }
    if clef != Clef::PERCUSSION {
        let k = read_key(f, s, clef, &us, from, right);
        let (n2, r2) = read_key_strokes(f, s, clef, right);
        if n2.unsigned_abs() > k.fifths.unsigned_abs() {
            // 按竖笔数出来的更多：墨连成片，单元读不全
            out.key = Some(Key { fifths: n2 });
            out.key_sure = out.clef_sure;
            right = r2;
        } else {
            out.key = Some(Key { fifths: k.fifths });
            out.key_sure = k.sure && out.clef_sure;
            right = k.right;
        }
    }
    if let Some(t) = read_time(f, s, &us, right - sp * 0.2, ocr) {
        out.time = t.time;
        right = t.right;
    }
    out.lead_end = right;
    out
}
