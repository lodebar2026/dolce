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

fn wordy(c: char) -> bool {
    c.is_ascii_alphanumeric() || crate::chars::is_latin(c) || c == '\'' || c == '’'
}

/// 在逐字序列里补词间空格（插入 `' '`，位置取那道空白的两缘）。`blanks`：行里的空白列段 `(起, 宽)`，与字同一坐标系；
/// `ink_h`：行的墨高。只在两侧都是字母 / 数字（数字与数字之间除外）处插；半角句读之后接字母的也插。
pub fn recover_spaces(chars: &[Ch], blanks: &[(f64, f64)], ink_h: f64) -> Vec<Ch> {
    if chars.len() < 2 {
        return chars.to_vec();
    }
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
    let thr = split_gaps(if word_ws.is_empty() { &all } else { &word_ws }, ink_h).max(ink_h * 0.14);
    let mut after: Vec<Option<(f64, f64)>> = vec![None; chars.len()];
    let mut gap: Vec<f64> = vec![0.0; chars.len()];
    for &(bx, bw) in blanks {
        let Some(i) = left_of(bx, bw) else { continue };
        gap[i] = gap[i].max(bw);
        if bw >= thr && pair_ok(i) {
            after[i] = Some((bx, bx + bw));
        }
    }
    for i in 1..chars.len() - 1 {
        if ",;:!?.".contains(chars[i].ch) && crate::chars::is_latin(chars[i + 1].ch) && gap[i] >= thr {
            after[i] = Some((chars[i].x1, chars[i + 1].x0));
        }
    }
    let mut out = Vec::with_capacity(chars.len() + 8);
    for (i, c) in chars.iter().enumerate() {
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
        // "ofmy"：o f | m y，中间一道宽白
        let cs: Vec<Ch> = "ofmy".chars().enumerate().map(|(i, ch)| { let x = i as f64 * 10.0 + if i >= 2 { 8.0 } else { 0.0 }; Ch { ch, x0: x, x1: x + 8.0 } }).collect();
        let out = recover_spaces(&cs, &[(8.0, 2.0), (18.0, 10.0), (36.0, 2.0)], 16.0);
        assert_eq!(out.iter().map(|c| c.ch).collect::<String>(), "of my");
    }
}
