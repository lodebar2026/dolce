//! CTC 贪心解码：逐时间步取最大类，一段连续的非空标签算一个字。
use serde::{Deserialize, Serialize};

/// 一个字与它在条内容宽上的左右缘（0..1）。左缘取字那一段的起点（歌词按它对齐音符），右缘供按字间空隙判词界。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CharPos {
    pub ch: String,
    pub x0: f64,
    pub x1: f64,
}

/// 一个字的候选：贪心解出的字与前几名（分降序，含它自己）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RankedChar {
    pub ch: String,
    pub alts: Vec<String>,
    pub scores: Vec<f32>,
}

fn argmax_rows(logits: &[f32], t: usize, c: usize) -> Vec<usize> {
    (0..t)
        .map(|i| {
            let row = &logits[i * c..(i + 1) * c];
            let mut best = 0;
            for k in 1..c {
                if row[k] > row[best] {
                    best = k;
                }
            }
            best
        })
        .collect()
}

/// 各段 `(类, 起, 止)`：连续同一非空标签为一段（段间以空白或换标签分开）。
fn runs(idx: &[usize]) -> Vec<(usize, usize, usize)> {
    let mut out = Vec::new();
    let (mut prev, mut i0) = (0usize, 0usize);
    for t in 0..=idx.len() {
        let cur = if t < idx.len() { idx[t] } else { usize::MAX };
        if cur != prev {
            if prev != 0 && prev != usize::MAX {
                out.push((prev, i0, t));
            }
            i0 = t;
            prev = cur;
        }
    }
    out
}

/// logits `[T, C]` → 逐字。`w` 是条的内容宽、`tw` 是张量宽（时间步按张量宽均分，换回内容宽的比例）。
pub fn decode(logits: &[f32], t: usize, c: usize, chars: &[String], w: usize, tw: usize) -> Vec<CharPos> {
    let idx = argmax_rows(logits, t, c);
    let frac = |s: usize| ((s as f64 * tw as f64 / t as f64) / w as f64).clamp(0.0, 1.0);
    runs(&idx)
        .into_iter()
        .filter_map(|(k, a, b)| {
            let ch = chars.get(k)?;
            (!ch.is_empty()).then(|| CharPos { ch: ch.clone(), x0: frac(a), x1: frac(b) })
        })
        .collect()
}

/// 逐字前 `k` 名：每段里各类（空白除外）取段内最大分，按分降序（并列时类号小的在前）。
pub fn rank(logits: &[f32], t: usize, c: usize, chars: &[String], k: usize) -> Vec<RankedChar> {
    let idx = argmax_rows(logits, t, c);
    runs(&idx)
        .into_iter()
        .filter_map(|(cls, a, b)| {
            let ch = chars.get(cls).filter(|s| !s.is_empty())?.clone();
            let mut best: Vec<(usize, f32)> = (1..c).map(|j| (j, (a..b).map(|tt| logits[tt * c + j]).fold(f32::NEG_INFINITY, f32::max))).collect();
            best.sort_by(|x, y| y.1.total_cmp(&x.1).then(x.0.cmp(&y.0)));
            best.truncate(k);
            let (alts, scores) = best.into_iter().filter_map(|(j, v)| chars.get(j).filter(|s| !s.is_empty()).map(|s| (s.clone(), v))).unzip();
            Some(RankedChar { ch, alts, scores })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_runs() {
        let chars: Vec<String> = ["", "a", "b"].iter().map(|s| s.to_string()).collect();
        // T=6：a a _ b b a
        let rows = [1, 1, 0, 2, 2, 1];
        let mut l = vec![0f32; 6 * 3];
        for (t, &k) in rows.iter().enumerate() {
            l[t * 3 + k] = 1.0;
        }
        let out = decode(&l, 6, 3, &chars, 60, 60);
        assert_eq!(out.iter().map(|c| c.ch.as_str()).collect::<String>(), "aba");
        assert_eq!((out[0].x0, out[0].x1), (0.0, 2.0 / 6.0));
        let r = rank(&l, 6, 3, &chars, 2);
        assert_eq!(r[1].alts, vec!["b", "a"]);
    }
}
