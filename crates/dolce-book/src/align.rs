//! GT 字符序列 ↔ 页面字形序列的对齐（照 `src/pdflayout/align.ts`）：字形自举建库与重排补字共用同一套判据。
//!
//! GT 串按 UTF-16 码元取下标（TS `gt.length` / `gt[i]`）；页面序列每项是一段串（读不出为 `None`），
//! 与 GT 的一个码元相等才算命中。

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlignPair {
    /// GT 串里的下标（UTF-16 码元）
    pub i: usize,
    /// 页面序列里的下标
    pub j: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AlignResult {
    pub pairs: Vec<AlignPair>,
    /// 长度相等且已识字大体对得上——无歧义直配
    pub direct: bool,
}

/// 对齐参数；缺省值见 [`AlignOptions::resolved`]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignOptions {
    /// 空位罚分
    pub gap: Option<f64>,
    /// 已知形状且字符相同 / 不同的分值
    pub hit: Option<f64>,
    pub miss: Option<f64>,
    /// 未知形状（读不出的字）的中性偏正分
    pub wild: Option<f64>,
    /// 直配所需的「已识字命中率」下限
    pub direct_min_hit: Option<f64>,
    /// 长度差超过 max(absTol, min(n,m) × relTol) 就不对齐
    pub abs_tol: Option<f64>,
    pub rel_tol: Option<f64>,
}

struct Opts {
    gap: f64,
    hit: f64,
    miss: f64,
    wild: f64,
    direct_min_hit: f64,
    abs_tol: f64,
    rel_tol: f64,
}

impl AlignOptions {
    fn resolved(&self) -> Opts {
        Opts {
            gap: self.gap.unwrap_or(-1.2),
            hit: self.hit.unwrap_or(2.0),
            miss: self.miss.unwrap_or(-1.5),
            wild: self.wild.unwrap_or(0.6),
            direct_min_hit: self.direct_min_hit.unwrap_or(0.6),
            abs_tol: self.abs_tol.unwrap_or(8.0),
            rel_tol: self.rel_tol.unwrap_or(0.4),
        }
    }
}

/// `alignSeq`：对不上（长度差太大 / 空序列）回 None
pub fn align_seq(gt: &str, dec: &[Option<String>], opt: &AlignOptions) -> Option<AlignResult> {
    let o = opt.resolved();
    let gt: Vec<u16> = gt.encode_utf16().collect();
    let n = gt.len();
    let m = dec.len();
    let (nf, mf) = (n as f64, m as f64);
    if n == 0 || m == 0 || (nf - mf).abs() > dolce_model::base::js::max(o.abs_tol, nf.min(mf) * o.rel_tol) {
        return None;
    }
    // 页面那一项与 GT 第 i 个码元相等
    let eq = |j: usize, i: usize| dec[j].as_deref().is_some_and(|s| s.encode_utf16().eq(std::iter::once(gt[i])));

    if n == m {
        let (mut known, mut ok) = (0usize, 0usize);
        for (t, d) in dec.iter().enumerate() {
            if d.is_some() {
                known += 1;
                if eq(t, t) {
                    ok += 1;
                }
            }
        }
        if known == 0 || ok as f64 / known as f64 >= o.direct_min_hit {
            return Some(AlignResult { pairs: (0..m).map(|t| AlignPair { i: t, j: t }).collect(), direct: true });
        }
    }

    let score = |i: usize, j: usize| -> f64 {
        if dec[j].is_none() {
            o.wild
        } else if eq(j, i) {
            o.hit
        } else {
            o.miss
        }
    };
    let mut dp = vec![vec![0.0f64; m + 1]; n + 1];
    for (i, row) in dp.iter_mut().enumerate().skip(1) {
        row[0] = i as f64 * o.gap;
    }
    for (j, v) in dp[0].iter_mut().enumerate().skip(1) {
        *v = j as f64 * o.gap;
    }
    for i in 1..=n {
        for j in 1..=m {
            let a = dp[i - 1][j - 1] + score(i - 1, j - 1);
            let b = dp[i - 1][j] + o.gap;
            let c = dp[i][j - 1] + o.gap;
            dp[i][j] = dolce_model::base::js::max(dolce_model::base::js::max(a, b), c);
        }
    }
    let mut pairs = vec![];
    let (mut i, mut j) = (n, m);
    while i > 0 && j > 0 {
        if dp[i][j] == dp[i - 1][j - 1] + score(i - 1, j - 1) {
            pairs.push(AlignPair { i: i - 1, j: j - 1 });
            i -= 1;
            j -= 1;
        } else if dp[i][j] == dp[i - 1][j] + o.gap {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    pairs.reverse();
    Some(AlignResult { pairs, direct: false })
}
