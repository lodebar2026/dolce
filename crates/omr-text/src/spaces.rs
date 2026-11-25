//! 词间空格：rec 不吐空格，按行里真实的空白列补。输入是空白列段（位置、宽）与逐字位置，不碰像素。
use crate::Ch;

/// 字母间白与词间白的分界：空白宽度取对数、按两类间方差最大切成两簇，两簇的几何均值差 2.5 倍以上才算分得开，
/// 界取两簇相邻两值的几何中点；分不开（整行一个词、字距匀开的一串大写）回无穷大。只有一道空白的，宽过 0.3 墨高才算词界。
pub fn split_gaps(ws: &[f64], h: f64) -> f64 {
    let mut v: Vec<f64> = ws.iter().copied().filter(|&w| w > 1.0).collect();
    v.sort_by(f64::total_cmp);
    if v.len() < 2 {
        return h * 0.3;
    }
    let lg: Vec<f64> = v.iter().map(|w| w.ln()).collect();
    let total: f64 = lg.iter().sum();
    let (mut best, mut k, mut s0) = (-1.0, 0, 0.0);
    for i in 1..lg.len() {
        s0 += lg[i - 1];
        let (m0, m1) = (s0 / i as f64, (total - s0) / (lg.len() - i) as f64);
        let b = (i * (lg.len() - i)) as f64 * (m1 - m0).powi(2);
        if lg[i] > lg[i - 1] && b > best {
            best = b;
            k = i;
        }
    }
    if k == 0 {
        return f64::INFINITY;
    }
    let m0 = lg[..k].iter().sum::<f64>() / k as f64;
    let m1 = lg[k..].iter().sum::<f64>() / (lg.len() - k) as f64;
    if m1 - m0 < 2.5f64.ln() {
        return f64::INFINITY;
    }
    (v[k - 1] * v[k]).sqrt()
}

/// 词间白的门：[`split_gaps`]；分不开两簇时，字母多半挨着、只有词间留了白（`Lordforme` 只有两道 9~10 像素的白，
/// 字母间是 0~1 像素、不进统计）。白从宽到窄排，找头一处比下一道宽出 2.5 倍（与两簇的分界同一个比）的断口：断口以上的
/// 不到字数三分之一、最窄那道也过 0.14 墨高，就是词界（匀开的一串大写每个字母间都有白，到不了；迦南 1940 `Declareayearoftriumph`
/// 白 5/4/4/3 对字母间 1）。最窄的一道再往下按 1 像素算。
fn word_gap(ws: &[f64], h: f64, n_chars: usize) -> f64 {
    let t = split_gaps(ws, h);
    // 宽过 1 像素的白只有一道时 split_gaps 按 0.3 墨高定界；字母间那几道 0~1 像素的白也算上，仍照下面的断口找
    // （迦南 1942 `We'refamily`：白 1/1/9，墨高 34 连着 f、y 的上下伸）。这时一道白要宽过 0.2 墨高：
    // 衬线体两个字母之间也能留出 0.15 墨高的白（青年诗歌 22 `to` 白 6、行高 40）
    let single = ws.iter().filter(|&&w| w > 1.0).count() < 2;
    let floor = if single { 0.2 } else { 0.14 };
    if t.is_finite() && !single {
        return t;
    }
    let mut v: Vec<f64> = ws.to_vec();
    v.sort_by(|a, b| b.total_cmp(a));
    for j in 1..=v.len() {
        let next = v.get(j).copied().unwrap_or(1.0).max(1.0);
        if v[j - 1] >= next * 2.5 {
            if j * 3 <= n_chars && v[j - 1] >= h * floor {
                return v[j - 1].min(t);
            }
            break;
        }
    }
    t
}

/// 第 `j` 道空白两侧墨段的字心距（墨段 = 相邻两道空白之间的墨，行两头以墨的左右缘为界）。
fn run_pitch(blanks: &[(f64, f64)], j: usize, x0: f64, x1: f64) -> f64 {
    let (bx, bw) = blanks[j];
    let la = if j == 0 { x0 } else { blanks[j - 1].0 + blanks[j - 1].1 };
    let rb = blanks.get(j + 1).map_or(x1, |b| b.0);
    (bx + bw + rb) / 2.0 - (la + bx) / 2.0
}

/// 等宽字体的字距（[`recover_spaces`] 拿它否决窄字母两侧的宽白）：字母间各道空白（`letter(起, 宽)` 选出两侧都是字母的）两侧墨段的字心距，
/// 不到 1.5 倍中位数的那些里九成以上都落在中位数 ±10% 以内（比例字体 `l`、`m` 的字心距差一倍多，到不了；小号字母粘连的 `Lesson of love` 也只有八成）、
/// 且至少 5 道，才回中位数；否则 None。
fn mono_pitch(blanks: &[(f64, f64)], x0: f64, x1: f64, letter: impl Fn(f64, f64) -> bool) -> Option<f64> {
    let mut d: Vec<f64> = (0..blanks.len()).filter(|&j| letter(blanks[j].0, blanks[j].1)).map(|j| run_pitch(blanks, j, x0, x1)).collect();
    d.sort_by(f64::total_cmp);
    let med = *d.get(d.len() / 2)?;
    let near: Vec<f64> = d.into_iter().filter(|&v| v < med * 1.5).collect();
    let tight = near.iter().filter(|&&v| (v - med).abs() <= med * 0.1).count();
    if std::env::var("OMR_SPACE_DEBUG").is_ok() {
        eprintln!("  字心距 中位{med:.1} 近{} 紧{} {:?}", near.len(), tight, near.iter().map(|v| *v as i64).collect::<Vec<_>>());
    }
    (near.len() >= 5 && tight * 10 >= near.len() * 9).then_some(med)
}

fn wordy(c: char) -> bool {
    c.is_ascii_alphanumeric() || crate::chars::is_latin(c) || c == '\'' || c == '’'
}

/// 在逐字序列里补词间空格（插入 `' '`，位置取那道空白的两缘）。`blanks`：行里的空白列段 `(起, 宽)`，与字同一坐标系；
/// `ink_h`：行的墨高；`(x0, x1)`：行的墨的左右缘。只在两侧都是字母 / 数字（数字与数字之间除外）处插；半角句读之后接字母的也插。
pub fn recover_spaces(chars0: &[Ch], blanks: &[(f64, f64)], ink_h: f64, x0: f64, x1: f64) -> Vec<Ch> {
    if chars0.len() < 2 {
        return chars0.to_vec();
    }
    // rec 给的字位是按时间步折回来的，常整体偏一点（窄字母旁边差半个字，空格就落到邻字的另一侧：`shall speak` → `shal lspeak`）。
    // 先估这一行的整体偏移：挪多少能让最多的字心落在墨上（不落在宽空白里、不出行的两头），并列取挪得少的
    let unit = (x1 - x0) / chars0.len() as f64;
    let wide = word_gap(&blanks.iter().map(|b| b.1).collect::<Vec<_>>(), ink_h, chars0.len()).max(ink_h * 0.14);
    let on_ink = |x: f64| x >= x0 && x <= x1 && !blanks.iter().any(|&(bx, bw)| bw >= wide && x > bx && x < bx + bw);
    let mut best = (0usize, 0.0f64);
    for k in -6i32..=6 {
        let d = k as f64 * 0.25 * unit;
        let n = chars0.iter().filter(|c| on_ink(c.cx() + d)).count();
        if n > best.0 || (n == best.0 && d.abs() < best.1.abs()) {
            best = (n, d);
        }
    }
    let shifted: Vec<Ch> = chars0.iter().map(|c| Ch { ch: c.ch, x0: c.x0 + best.1, x1: c.x1 + best.1 }).collect();
    let chars = &shifted[..];
    // 每道空白左边那个字的下标
    let left_of = |bx: f64, bw: f64| -> Option<usize> {
        let mid = bx + bw / 2.0;
        let n = chars.iter().take_while(|c| c.cx() < mid).count();
        (n >= 1 && n < chars.len()).then(|| n - 1)
    };
    let digit = |c: char| c.is_ascii_digit();
    let pair_ok = |i: usize| wordy(chars[i].ch) && wordy(chars[i + 1].ch) && !(digit(chars[i].ch) && digit(chars[i + 1].ch));
    let word_ws: Vec<f64> = blanks.iter().filter(|&&(x, w)| left_of(x, w).is_some_and(pair_ok)).map(|b| b.1).collect();
    let all: Vec<f64> = blanks.iter().map(|b| b.1).collect();
    let thr = word_gap(if word_ws.is_empty() { &all } else { &word_ws }, ink_h, chars0.len()).max(ink_h * 0.14);
    let pitch = mono_pitch(blanks, x0, x1, |bx, bw| left_of(bx, bw).is_some_and(pair_ok));
    let mut after: Vec<Option<(f64, f64)>> = vec![None; chars.len()];
    let mut gap: Vec<f64> = vec![0.0; chars.len()];
    for (j, &(bx, bw)) in blanks.iter().enumerate() {
        let Some(i) = left_of(bx, bw) else { continue };
        gap[i] = gap[i].max(bw);
        // 等宽字体：窄字母（i、l）两边的白也宽，过了门也要看两侧墨段的字心距——不到 1.25 倍字距的没隔出一格，不是词界
        // （只否决、不新增：加了字距的比例字体词间字心距也只有 1.46 倍，空白宽本就分得开，迦南 2252 `Song of the Libega`）
        let word = bw >= thr && pitch.is_none_or(|p| run_pitch(blanks, j, x0, x1) >= p * 1.25);
        if word && pair_ok(i) {
            after[i] = Some((bx, bx + bw));
        }
    }
    for i in 1..chars.len() - 1 {
        if ",;:!?.".contains(chars[i].ch) && crate::chars::is_latin(chars[i + 1].ch) && gap[i] >= thr {
            after[i] = Some((chars[i].x1, chars[i + 1].x0));
        }
    }
    let mut out = Vec::with_capacity(chars.len() + 8);
    for (i, c) in chars0.iter().enumerate() {
        out.push(c.clone());
        if let Some((a, b)) = after[i] {
            out.push(Ch { ch: ' ', x0: a, x1: b });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_clusters() {
        assert!((split_gaps(&[2.0, 3.0, 2.0, 12.0, 14.0], 20.0) - 6.0).abs() < 0.1);
        assert!(split_gaps(&[2.0, 3.0, 4.0], 20.0).is_infinite());
    }

    #[test]
    fn spaces_between_words() {
        // 墨：shall 占 0~32，白 32~44，speak 占 44~84；字位整体偏右 5（末一个 l 的字心落进了词间的白里）
        let centers = [3.0, 10.0, 17.0, 23.0, 29.0, 48.0, 56.0, 64.0, 72.0, 78.0];
        let cs: Vec<Ch> = "shallspeak".chars().zip(centers).map(|(ch, c)| Ch { ch, x0: c + 2.0, x1: c + 8.0 }).collect();
        let blanks = [(6.0, 2.0), (14.0, 2.0), (22.0, 2.0), (26.0, 2.0), (32.0, 12.0), (50.0, 2.0), (58.0, 2.0), (66.0, 2.0), (74.0, 2.0)];
        let out = recover_spaces(&cs, &blanks, 16.0, 0.0, 84.0);
        assert_eq!(out.iter().map(|c| c.ch).collect::<String>(), "shall speak");
    }

    #[test]
    fn monospace_narrow_letters() {
        // 等宽字体 `Christmas Guace`（issue 41 副标题的读数）：i 两边的白 15/14 比别的字母间宽，词间 31，字心距一律约 26、词间 51
        let blanks = [(918.0, 5.0), (943.0, 8.0), (966.0, 15.0), (987.0, 14.0), (1020.0, 5.0), (1045.0, 5.0), (1074.0, 3.0), (1098.0, 6.0), (1123.0, 31.0), (1175.0, 6.0), (1201.0, 5.0), (1227.0, 5.0), (1253.0, 5.0)];
        let centers = [912.0, 930.0, 957.0, 984.0, 1012.0, 1039.0, 1066.0, 1093.0, 1120.0, 1165.0, 1192.0, 1219.0, 1246.0, 1273.0];
        let cs: Vec<Ch> = "ChristmasGuace".chars().zip(centers).map(|(ch, c)| Ch { ch, x0: c - 8.0, x1: c + 8.0 }).collect();
        let out = recover_spaces(&cs, &blanks, 35.0, 896.0, 1279.0);
        assert_eq!(out.iter().map(|c| c.ch).collect::<String>(), "Christmas Guace");
    }
}

/// 一段读出的字（rec 常把几个字并成一段、只给一个位置）按字数均分 `[a, b)`，逐字追加到 `out`。
pub fn spread(text: impl IntoIterator<Item = char>, a: f64, b: f64, out: &mut Vec<Ch>) {
    let cs: Vec<char> = text.into_iter().collect();
    let n = cs.len().max(1) as f64;
    for (i, ch) in cs.into_iter().enumerate() {
        out.push(Ch { ch, x0: a + (b - a) * i as f64 / n, x1: a + (b - a) * (i + 1) as f64 / n });
    }
}

/// 一条读出的各段 `(字串, 条内比例左缘, 右缘)` 逐段 [`spread`]，比例位置经 `at` 折成页内坐标；`map` 逐字换写或筛掉（回 None）。
pub fn spread_all<'a>(segs: impl IntoIterator<Item = (&'a str, f64, f64)>, at: impl Fn(f64) -> f64, map: impl Fn(char) -> Option<char>) -> Vec<Ch> {
    let mut out = Vec::new();
    for (text, a, b) in segs {
        spread(text.chars().filter_map(&map), at(a), at(b), &mut out);
    }
    out
}

/// 一个框里的墨（补词间空格用）：墨列之间的空白段 `(起, 宽)`、墨的左缘、右缘（不含）、墨高。
#[derive(Clone, Debug, PartialEq)]
pub struct BoxInk {
    pub blanks: Vec<(f64, f64)>,
    pub left: f64,
    pub right: f64,
    pub height: f64,
}

/// 扫框 `[x0, x1) × [y0, y1)` 里的墨；`col(x)` 这一列有没有墨、`row(y)` 这一行有没有墨（都只看框里）。没有墨回 None。
pub fn box_ink(x0: i64, x1: i64, y0: i64, y1: i64, col: impl Fn(i64) -> bool, row: impl Fn(i64) -> bool) -> Option<BoxInk> {
    let inked: Vec<i64> = (x0..x1).filter(|&x| col(x)).collect();
    let (&a, &z) = (inked.first()?, inked.last()?);
    let blanks = inked.windows(2).filter(|p| p[1] > p[0] + 1).map(|p| ((p[0] + 1) as f64, (p[1] - p[0] - 1) as f64)).collect();
    let top = (y0..y1).find(|&y| row(y));
    let bot = (y0..y1).rev().find(|&y| row(y));
    let height = match (top, bot) {
        (Some(t), Some(b)) => (b - t + 1) as f64,
        _ => 0.0,
    };
    Some(BoxInk { blanks, left: a as f64, right: (z + 1) as f64, height })
}
