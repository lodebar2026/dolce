//! **行首区**：每行谱开头按次序认谱号 → 调号 → 拍号。
//!
//! - 谱号按单元上下沿在谱表上的位置分（高音谱号上下都探出谱表、低音谱号从第五线挂到第二线一带且右边有两点、
//!   中音谱号正好撑满谱表且左边两根竖笔），不比模板。
//! - 调号按**位置自证**：谱号定了，第 i 个升号 / 降号该在哪条线、哪个间是定的；单元挨个往右接，位置对得上、形状不矛盾的才算。
//! - 拍号：上下两个数字正好各占半个谱表，数字交给 OCR；C / ¢ 骑在中线上。
use super::units::{carve_after_line, ink_in, merged, single, split_at, stems, strokes, units_in, Unit};
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
pub(crate) const KEY_GAP_FIRST: f64 = 2.2;
pub(crate) const KEY_GAP: f64 = 1.5;
/// 调号记号的位置容差（音级位置，半格为 1）。
pub(crate) const KEY_POS_TOL: f64 = 0.85;
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
        // 还原号的两笔长的也过七成：它是错开的——左笔顶着上沿、够不着下沿，右笔踩着下沿、够不着上沿（升号反过来：左笔低、右笔高，且差得少）
        let (a, b) = (tall[0], tall[tall.len() - 1]);
        let staggered = (a.2 as f64 - y0) < h * 0.12 && (y1 - a.3 as f64) > h * 0.15 && (y1 - b.3 as f64) < h * 0.12 && (b.2 as f64 - y0) > h * 0.15;
        return Some(if staggered { Acc::Natural } else { Acc::Sharp });
    }
    if tall.len() == 1 {
        let s = tall[0];
        // 竖笔在左边、顶天立地；右下有墨、右上没有。竖笔不到通高的往下按还原号看（还原号左笔长的到近八成、右笔不到七成）
        let left = (s.0 as f64 + s.1 as f64) / 2.0 < x0 + u.rect.w * 0.4;
        if left && ((s.3 - s.2 + 1) as f64) >= h * 0.85 {
            let (xa, xb) = (s.1 + 1, x1.ceil() as i64 - 1);
            if xb < xa {
                return None;
            }
            let ym = (y0 + h * 0.35) as i64;
            let up = ink_in(f, xa, xb, y0 as i64, ym);
            let down = ink_in(f, xa, xb, ym + 1, y1 as i64);
            return (down > up * 2 && down as f64 >= sp * sp * 0.08).then_some(Acc::Flat);
        }
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
    // 外侧从竖笔再让出一笔宽起量：竖笔两三像素宽时只有一列够长，旁边那列是它自己
    let m = ((sp * 0.12).round() as i64).max(1);
    let out = ink_in(f, x0 as i64, a.0 - 1 - m, y0 as i64, y1 as i64) + ink_in(f, b.1 + 1 + m, x1 as i64, y0 as i64, y1 as i64);
    (a_short && b_short && (out as f64) < sp * sp * 0.06).then_some(Acc::Natural)
}

/// 升降号在谱表上「指着」的音级位置：升号、还原号是中心，降号是肚子的中心（有竖笔时量竖笔右侧肚子的上下沿中点，否则下沿往上半格）。
pub fn acc_pos(u: &Unit, kind: Acc) -> f64 {
    match kind {
        Acc::Flat => u.bottom - 1.0,
        _ => u.mid(),
    }
}

fn flat_pos(f: &PageFrame, s: &Staff, u: &Unit) -> f64 {
    let st = stems(f, u, 0.72);
    if let Some(stem) = st.first() {
        let xa = stem.1 + 2;
        let xb = u.rect.right().ceil() as i64 - 1;
        if xb >= xa {
            let (y0, y1) = (u.rect.y.floor() as i64, u.rect.bottom().ceil() as i64);
            let mut rows = (y0..=y1).filter(|&y| (xa..=xb).any(|x| f.ink.at(x, y) == crate::frame::ink::INK));
            if let Some(top) = rows.next() {
                let bot = rows.last().unwrap_or(top);
                return s.pos(u.rect.cx(), (top + bot) as f64 / 2.0);
            }
        }
    }
    u.bottom - 1.0
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
    // 高音谱号：上端在首线上方一格半到两格多、下端在末线下方一格上下（挂着 8 的再低两格）；探得更远的是连着别的东西
    if u.top <= -1.0 && u.top >= -5.3 && u.bottom >= 8.8 && u.bottom <= 15.6 && h >= 5.0 {
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
        // 谱号与系统线、括号连成一大块：把系统线之后的那部分刻出来当谱号的单元
        let carved;
        let u = if u.h(sp) > 10.5 && u.rect.right() > s.left + sp * 1.0 {
            // 先在整条谱表带里刻；判不出再只在谱表以内刻（括号下端的弯钩伸在末线下面，会把低音谱号的下沿拉低）
            let full = carve_after_line(f, s, u, sp * 3.4, -6.0, 14.0).filter(|c| c.rect.x >= s.left - sp * 1.5);
            let inner = || carve_after_line(f, s, u, sp * 3.4, -1.5, 7.85).filter(|c| c.rect.x >= s.left - sp * 1.5 && clef_shape(f, c, sp).is_some_and(|k| k.0 == Clef::BASS));
            if std::env::var("OMR_CLEF_DEBUG").is_ok() {
                let d = |c: &Option<Unit>| c.as_ref().map(|c| (c.rect.x as i64, c.top, c.bottom, c.w(sp), c.h(sp), clef_shape(f, c, sp).map(|k| k.0)));
                eprintln!("刻谱号 行左 {:.0}：整带 {:?} 谱表内 {:?}", s.left, d(&full), d(&carve_after_line(f, s, u, sp * 3.4, -1.5, 7.85)));
            }
            // 刻出来的下沿不可靠（括号钩、花括号都在这一带）：只收不带 8 的高音谱号
            // 也不收太窄的（高音谱号宽约是高的 0.38）：末行括号的下钩连着下面的墨，刻出来 0.9 格宽、7 格高，按位置像高音谱号（新编 236、164 末行低音谱表读成 G）
            match full.filter(|c| clef_shape(f, c, sp).is_some_and(|k| k.0 == Clef::TREBLE && c.bottom <= 12.0) && c.w(sp) >= c.h(sp) * 0.25).or_else(inner) {
                Some(c) => {
                    carved = c;
                    &carved
                }
                None => continue,
            }
        } else {
            // 系统线、括号：贴着左端的细长竖笔，或整个在左端以左
            if u.rect.right() < s.left + sp * 0.5 || u.rect.x < s.left - sp * 0.3 || (u.w(sp) < 0.5 && u.h(sp) >= 3.0) {
                continue;
            }
            u
        };
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
        // 并进了不相干的东西（谱号正上方的小节号、排练号）而判不出的：拿里面最高的那一块单独判
        let alone;
        let u = if clef_shape(f, &whole, sp).is_none() && whole.ids.len() > 1 {
            let tallest = whole.ids.iter().filter_map(|&id| f.blobs.iter().find(|b| b.id as i32 == id)).max_by(|a, b| a.rect.h.total_cmp(&b.rect.h));
            match tallest {
                Some(b) => {
                    alone = single(s, b.rect, b.id as i32, b.area as f64);
                    &alone
                }
                None => &whole,
            }
        } else {
            &whole
        };
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
    // 纵向不沾谱表的（谱表上方的和弦字、下方的字）不在调号串里，先跳过以免夹在竖笔与肚子之间挡住合并
    let on_staff = |u: &Unit| u.bottom >= -3.0 && u.top <= 9.5;
    let mut joined: Vec<Unit> = Vec::new();
    for u in &us[from.min(us.len())..] {
        if !on_staff(u) || (u.w(sp) < 0.4 && u.h(sp) < 0.7) {
            continue;
        }
        if let Some(a) = joined.last() {
            let stem = a.w(sp) < 0.45 && (1.5..=3.3).contains(&a.h(sp));
            let bowl = (0.6..=1.7).contains(&u.h(sp)) && (0.3..=1.0).contains(&u.w(sp));
            if stem && bowl && u.rect.x - a.rect.right() <= sp * 0.4 && u.rect.x >= a.rect.x && (u.rect.bottom() - a.rect.bottom()).abs() <= sp * 0.4 {
                let m = merged(s, a, u);
                *joined.last_mut().unwrap() = m;
                continue;
            }
        }
        joined.push(u.clone());
    }
    let (us, from) = (&joined[..], 0usize);
    let mut best = KeyHit { fifths: 0, sure: true, right: start, used: 0 };
    let dbg = std::env::var("OMR_KEY_DEBUG").is_ok();
    let mut why: Vec<String> = Vec::new();
    for sharp in [true, false] {
        let (mut n, mut right, mut used, mut sure) = (0usize, start, 0usize, true);
        let mut j = from;
        let mut brk = String::from("到头");
        while j < us.len() && n < 7 {
            let u = &us[j];
            // 不沾谱表的、碎点（低音谱号的两点、污点）跳过
            if !on_staff(u) || (u.h(sp) < 1.2 && u.w(sp) < 1.0) {
                j += 1;
                continue;
            }
            let gap = if n == 0 { KEY_GAP_FIRST } else { KEY_GAP };
            if u.rect.x - right > sp * gap {
                brk = format!("间隔 {:.1} 格", (u.rect.x - right) / sp);
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
                let pos = if sharp { p.mid() } else { flat_pos(f, s, p) };
                let fits = acc_sized(p, sp)
                    && n < 7
                    && want.is_some_and(|w| (pos - w as f64).abs() <= KEY_POS_TOL)
                    && match kind {
                        Some(Acc::Sharp) => sharp,
                        Some(Acc::Flat) => !sharp,
                        Some(Acc::Natural) => false,
                        None => true,
                    };
                if !fits {
                    if dbg {
                        let pos = acc_pos(p, if sharp { Acc::Sharp } else { Acc::Flat });
                        let r = if !acc_sized(p, sp) { "尺寸" } else if want.is_none_or(|w| (pos - w as f64).abs() > KEY_POS_TOL) { "位置" } else { "种类" };
                        brk = format!("{r}（宽{:.2} 高{:.2} 位{:.1}..{:.1} 指{:.1} 要{:?} 认{:?} 粘{}）", p.w(sp), p.h(sp), p.top, p.bottom, pos, want, kind.map(|k| format!("{k:?}")), parts.len());
                    }
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
        if dbg {
            why.push(format!("{}{n} 断:{brk}", if sharp { "升" } else { "降" }));
        }
        if n > best.fifths.unsigned_abs() as usize {
            best = KeyHit { fifths: if sharp { n as i8 } else { -(n as i8) }, sure, right, used };
        } else if n == 0 && best.fifths == 0 {
            best.sure &= sure;
        }
    }
    if dbg {
        eprintln!("调号单元读 {}", why.join(" | "));
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
        if std::env::var("OMR_KEY_DEBUG").is_ok() {
            eprintln!("调号竖笔读 降{} 升{} 竖笔{}", if best.0 < 0 { -best.0 } else { 0 }, n, st.len());
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
pub(crate) fn cell(f: &PageFrame, x0: i64, x1: i64, y0: i64, y1: i64) -> Gray {
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

/// OCR 逐字候选 → 数：每个字取候选里排最前的数字（压着谱线、糊了孔的数字常被读成汉字，数字排在后几名）。
/// 一个字读一位，两个字读两位；`ok` 限定合法的数。
pub(crate) fn digits_of(alts: &[Vec<String>], ok: impl Fn(u32) -> bool) -> Option<u32> {
    // 一位数：候选前几名里排最前的合法数字；两位数（12、16）只认两个字都是头名的
    let digit = |a: &Vec<String>, top: usize, ok1: &dyn Fn(u32) -> bool| a.iter().take(top).filter_map(|s| s.parse::<u32>().ok().filter(|_| s.len() == 1)).find(|d| ok1(*d));
    match alts.len() {
        1 => digit(&alts[0], 4, &|d| ok(d)),
        2 => {
            let a = digit(&alts[0], 1, &|d| d == 1)?;
            let b = digit(&alts[1], 1, &|d| ok(a * 10 + d))?;
            Some(a * 10 + b)
        }
        _ => None,
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
    // 上下两半都得是「一个字」的模样：各自的墨横向铺开过半个列宽（一根竖笔带一个头的不是）
    let spread = |ya: i64, yb: i64| (x0 as i64..=x1 as i64).filter(|&x| (ya..=yb).any(|y| f.ink.at(x, y) == crate::frame::ink::INK)).count() as f64;
    if spread(ya, (ym - half * 0.3) as i64) < (x1 - x0) * 0.6 || spread((ym + half * 0.3) as i64, yb) < (x1 - x0) * 0.6 {
        return None;
    }
    // ¢：中线一带有一根竖笔穿过、且整体是一块（数字之间隔着中线，中线上只有存疑的线）
    let mid_ink = ink_in(f, x0 as i64, x1 as i64, (ym - sp * 0.12) as i64, (ym + sp * 0.12) as i64);
    let Some(ocr) = ocr else { return Some(TimeHit { time: None, right: x1 }) };
    let a = ocr.read_digit(&cell(f, x0 as i64 - 1, x1 as i64 + 1, ya, ym.round() as i64 - 1));
    let b = ocr.read_digit(&cell(f, x0 as i64 - 1, x1 as i64 + 1, ym.round() as i64 + 1, yb));
    let num = a.as_deref().and_then(|v| digits_of(v, |d| matches!(d, 2..=9 | 12)));
    let den = b.as_deref().and_then(|v| digits_of(v, |d| matches!(d, 2 | 4 | 8 | 16)));
    let t = time_from(num, den);
    if std::env::var("OMR_DBG").is_ok() {
        eprintln!("拍号列 x {:.0}..{:.0} 位 {:.1}..{:.1}：上「{}」下「{}」→ {:?}", x0, x1, top, bottom, a.as_ref().map_or("?".into(), |v| v.iter().map(|c| c.iter().take(4).cloned().collect::<String>()).collect::<Vec<_>>().join("|")), b.as_ref().map_or("?".into(), |v| v.iter().map(|c| c.iter().take(4).cloned().collect::<String>()).collect::<Vec<_>>().join("|")), t);
        if std::env::var("OMR_DBG").as_deref() == Ok("2") {
            for g in [cell(f, x0 as i64 - 1, x1 as i64 + 1, ya, ym.round() as i64 - 1), cell(f, x0 as i64 - 1, x1 as i64 + 1, ym.round() as i64 + 1, yb)] {
                for y in (0..g.h).step_by(2) {
                    eprintln!("  {}", (0..g.w).map(|x| if g.data[y * g.w + x] == 0 { '#' } else { '.' }).collect::<String>());
                }
            }
        }
    }
    if t.is_none() && us.len() == 1 && mid_ink as f64 > sp * 0.24 * sp * 0.15 && top >= -1.6 {
        // 读不成两个数字、中线上又有墨连着：当 ¢（骑中线的 C 加一根竖笔）
        let st = stems(f, us[0], 0.8);
        if st.len() == 1 && w >= 1.1 {
            return Some(TimeHit { time: Some(Time { beats: 2, beat_type: 2, symbol: TimeSymbol::Cut }), right: x1 });
        }
    }
    Some(TimeHit { time: t, right: x1 })
}

/// 行首拍号：`start`（谱号 / 调号右缘）之后、`end`（第一条小节线）之前，自左而右逐列试，第一列读得出拍号的算。
/// 调号没读全时拍号前面还隔着几个没认出的记号，所以不只看紧跟着的那一列。
pub fn read_time(f: &PageFrame, s: &Staff, us: &[Unit], start: f64, end: f64, ocr: Option<&dyn DigitReader>) -> Option<TimeHit> {
    let sp = s.space();
    let on_staff = |u: &Unit| u.bottom >= -1.5 && u.top <= 9.5 && u.rect.cx() > start && u.rect.right() < end && !(u.h(sp) < 1.2 && u.w(sp) < 1.0);
    let mut first = true;
    for u in us.iter().filter(|u| on_staff(u)) {
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
        match read_time_at(f, s, &col, ocr) {
            Some(t) if t.time.is_some() => return Some(t),
            // 紧跟着的那一列是拍号的模样却读不出：行首区照样算到它为止
            Some(t) if first && u.rect.x - start <= sp * TIME_GAP => return Some(t),
            _ => {}
        }
        first = false;
    }
    None
}

/// 行中 `[start, end]` 之间的拍号（小节线后换拍）：同行首拍号一份读法，读不出数回 None。
pub fn read_time_between(f: &PageFrame, row: usize, start: f64, end: f64, ocr: Option<&dyn DigitReader>) -> Option<Time> {
    let s = &f.staves[row];
    let sp = s.space();
    let us = units_in(f, s, start - sp * 0.5, end + sp, -6.0, 16.0);
    read_time(f, s, &us, start, end, ocr).and_then(|t| t.time)
}

/// 一行谱的行首区。
pub fn read_lead(f: &PageFrame, row: usize, ocr: Option<&dyn DigitReader>) -> RowAttrs {
    let s = &f.staves[row];
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
    // 行首区的右界：左端十四格以内、第一条小节线之前
    let end = f.bars[row].iter().map(|b| b.x0).find(|&x| x > right + sp).unwrap_or(f64::MAX).min(s.left + sp * 14.0);
    if let Some(t) = read_time(f, s, &us, right - sp * 0.2, end, ocr) {
        out.time = t.time;
        right = t.right;
    }
    out.lead_end = right;
    out
}
