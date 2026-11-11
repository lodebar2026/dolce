//! 声部指派与谱号 / 调号沿用：各系统的行配到哪个声部、全曲的调号与谱号读数顺着乐曲定下来。
use super::*;

/// 一行谱的特征（声部指派用）：谱号、在花括号的上半 / 下半、有没有词、音域中位、谱面印的声部标签。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StaffProfile {
    pub clef: Option<Clef>,
    pub brace: Option<BraceHalf>,
    pub lyric: bool,
    /// 音域中位（全音阶级数，`C4` = 28）；没有音为 None。
    pub pitch: Option<i32>,
    pub label: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BraceHalf {
    Top,
    Bottom,
}

/// 各页各系统各行谱的特征（按页序、系统序、自上而下）。
pub(super) fn profiles(pages: &[Page]) -> Vec<Vec<StaffProfile>> {
    let mut out = Vec::new();
    for page in pages {
        for sys in &page.layout.systems {
            out.push(
                sys.staves
                    .iter()
                    .map(|&i| {
                        let clef = page.attrs[i].clef;
                        // 音域：按行首谱号折算各头的全音阶级数取中位（谱号没认出就不量，免得 F 谱号的行按 G 算）
                        let pitch = clef.and_then(|c| median(page.notes[i].chords.iter().flat_map(|ch| ch.heads.iter()).map(|h| c.pitch_at(h.pos)).map(|p| p.octave as i32 * 7 + p.step as i32).collect()));
                        StaffProfile { clef, brace: None, lyric: !page.text.rows[i].lyrics.is_empty(), pitch, label: None }
                    })
                    .collect(),
            );
        }
    }
    out
}

/// 谱号对上 / 对不上的分（对不上要压得住音域那一项：谱号是硬证据）。同为 G 或 F、只差八度记号的不表态（八度小字常读丢）。
const CLEF_HIT: f64 = 2.0;
const CLEF_MISS: f64 = -6.0;
/// 花括号上下半对上 / 对不上的分。
const BRACE_HIT: f64 = 2.0;
const BRACE_MISS: f64 = -6.0;
/// 有没有词对上的分（单行漏认只丢这么多，不否决）。
const LYRIC_HIT: f64 = 1.5;
/// 标签对上 / 对不上（谱面写着的比量出来的硬，要压得过音域）。
const LABEL_HIT: f64 = 4.0;
const LABEL_MISS: f64 = -8.0;
/// 音域每差一级扣多少、最多扣多少。
const PITCH_W: f64 = 0.35;
const PITCH_CAP: f64 = 4.0;

/// 一个槽位（声部）的特征：由「行数最多那一档系统」的同位行众数 / 中位定。
#[derive(Clone, Debug, Default)]
struct Slot {
    clef: Option<Clef>,
    brace: Option<BraceHalf>,
    lyric: bool,
    pitch: Option<i32>,
    label: Option<String>,
}

fn mode<T: Clone + PartialEq>(v: impl Iterator<Item = T>) -> Option<(T, usize)> {
    let mut c: Vec<(T, usize)> = Vec::new();
    for x in v {
        match c.iter_mut().find(|e| e.0 == x) {
            Some(e) => e.1 += 1,
            None => c.push((x, 1)),
        }
    }
    // 票数相同取先出现的
    c.into_iter().rev().max_by_key(|e| e.1)
}

fn median(mut v: Vec<i32>) -> Option<i32> {
    v.sort_unstable();
    v.get(v.len() / 2).copied()
}

fn fit(t: &StaffProfile, s: &Slot, labels: bool) -> f64 {
    let mut v = 0.0;
    if let (Some(a), Some(b)) = (t.clef, s.clef) {
        v += if a == b {
            CLEF_HIT
        } else if a.sign == b.sign {
            0.0
        } else {
            CLEF_MISS
        };
    }
    if let (Some(a), Some(b)) = (t.brace, s.brace) {
        v += if a == b { BRACE_HIT } else { BRACE_MISS };
    }
    v += if t.lyric == s.lyric { LYRIC_HIT } else { -LYRIC_HIT };
    if let (Some(a), Some(b)) = (t.pitch, s.pitch) {
        v -= ((a - b).abs() as f64 * PITCH_W).min(PITCH_CAP);
    }
    if let (true, Some(a), Some(b)) = (labels, &t.label, &s.label) {
        v += if a == b { LABEL_HIT } else { LABEL_MISS };
    }
    v
}

/// 一个系统的 k 行保序落进 n 个槽位（一维 DP，分高者胜；打平时往下面的槽位放——少印的多半是上面的人声行，伴奏在最下）。
fn place(rows: &[StaffProfile], slots: &[Slot], labels: bool) -> Vec<usize> {
    let (k, n) = (rows.len(), slots.len());
    if k >= n {
        return (0..k).map(|i| i.min(n.saturating_sub(1))).collect();
    }
    const NEG: f64 = -1e18;
    let mut f = vec![vec![NEG; n + 1]; k + 1];
    let mut take = vec![vec![false; n + 1]; k + 1];
    f[0].iter_mut().for_each(|v| *v = 0.0);
    for i in 1..=k {
        for j in 1..=n {
            let skip = f[i][j - 1];
            let t = if f[i - 1][j - 1] > NEG { f[i - 1][j - 1] + fit(&rows[i - 1], &slots[j - 1], labels) } else { NEG };
            if t >= skip && t > NEG {
                f[i][j] = t;
                take[i][j] = true;
            } else {
                f[i][j] = skip;
            }
        }
    }
    let mut out = vec![0; k];
    let (mut i, mut j) = (k, n);
    while i > 0 && j > 0 {
        if take[i][j] {
            i -= 1;
            out[i] = j - 1;
        }
        j -= 1;
    }
    out
}

/// 同一档行数的系统之间把标签、花括号上下半传开（版式规矩：行数一样的系统各行身份也一样；标签只在声部进入处印一次）。只补空着的。
fn propagate(rows: &mut [Vec<StaffProfile>]) {
    let mut counts: Vec<usize> = rows.iter().map(|r| r.len()).filter(|&k| k > 0).collect();
    counts.sort_unstable();
    counts.dedup();
    for k in counts {
        let group: Vec<usize> = (0..rows.len()).filter(|&s| rows[s].len() == k).collect();
        if group.len() < 2 {
            continue;
        }
        for i in 0..k {
            if let Some((lb, _)) = mode(group.iter().filter_map(|&s| rows[s][i].label.clone())) {
                for &s in &group {
                    rows[s][i].label.get_or_insert_with(|| lb.clone());
                }
            }
        }
        let braced: Vec<usize> = group.iter().copied().filter(|&s| rows[s].iter().any(|t| t.brace.is_some())).collect();
        if braced.is_empty() {
            continue;
        }
        for &s in &group {
            if rows[s].iter().any(|t| t.brace.is_some()) {
                continue;
            }
            for i in 0..k {
                let n = |h: BraceHalf| braced.iter().filter(|&&b| rows[b][i].brace == Some(h)).count();
                if n(BraceHalf::Top) * 2 > braced.len() {
                    rows[s][i].brace = Some(BraceHalf::Top);
                } else if n(BraceHalf::Bottom) * 2 > braced.len() {
                    rows[s][i].brace = Some(BraceHalf::Bottom);
                }
            }
        }
    }
}

/// **全局指派**：各系统各行落进哪个槽位（声部）。槽位数 = 行数最多的那一档系统，槽位特征由那一档的同位行定；
/// 逐系统保序 DP。三遍：不看标签 → 给槽位定名（先认最满那一档同位行读出的，没有才按头一遍投票；一个名字只归一个槽位）后带标签再排 →
/// 按第二遍的结果重估各槽位的音域再排（最满那一档往往是高潮段、整体偏高）。
pub fn auto_slots(profiles: &[Vec<StaffProfile>]) -> Vec<Vec<usize>> {
    let mut rows = profiles.to_vec();
    propagate(&mut rows);
    let n = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    if n < 2 {
        return rows.iter().map(|r| vec![0; r.len()]).collect();
    }
    // 行数最多的那一档（只有这一个行数）
    let full: Vec<&Vec<StaffProfile>> = rows.iter().filter(|r| r.len() == n).collect();
    let mut slots: Vec<Slot> = (0..n)
        .map(|k| {
            let braces: Vec<BraceHalf> = full.iter().filter_map(|r| r[k].brace).collect();
            Slot {
                clef: mode(full.iter().filter_map(|r| r[k].clef)).map(|c| c.0),
                brace: if braces.len() * 2 > full.len() { mode(braces.into_iter()).map(|b| b.0) } else { None },
                lyric: full.iter().filter(|r| r[k].lyric).count() * 2 >= full.len(),
                pitch: median(full.iter().filter_map(|r| r[k].pitch).collect()),
                label: None,
            }
        })
        .collect();
    let run = |slots: &[Slot], labels: bool| -> Vec<Vec<usize>> { rows.iter().map(|r| place(r, slots, labels)).collect() };
    let first = run(&slots, false);
    // 槽位定名
    let mut votes_of = vec![0usize; n];
    for k in 0..n {
        let anchor = mode(full.iter().filter_map(|r| r[k].label.clone()));
        let voted = mode(rows.iter().zip(&first).filter_map(|(r, a)| a.iter().position(|&s| s == k).and_then(|i| r[i].label.clone())));
        slots[k].label = match (anchor, voted) {
            (Some((a, _)), _) => Some(a),
            (None, Some((v, c))) => {
                votes_of[k] = c;
                Some(v)
            }
            _ => None,
        };
    }
    for k in 0..n {
        let Some(lb) = slots[k].label.clone() else { continue };
        if votes_of[k] > 0 && (0..n).any(|j| j != k && slots[j].label.as_deref() == Some(&lb) && (votes_of[j] == 0 || votes_of[j] > votes_of[k])) {
            slots[k].label = None;
        }
    }
    let mut named: Vec<String> = slots.iter().filter_map(|s| s.label.clone()).collect();
    named.sort();
    named.dedup();
    let labels = named.len() >= 2;
    let second = if labels { run(&slots, true) } else { first };
    // 按第二遍重估音域
    for (k, slot) in slots.iter_mut().enumerate() {
        let ps: Vec<i32> = rows.iter().zip(&second).filter_map(|(r, a)| a.iter().position(|&s| s == k).and_then(|i| r[i].pitch)).collect();
        if let Some(p) = median(ps) {
            slot.pitch = Some(p);
        }
    }
    run(&slots, labels)
}

/// 各系统的调号读数（同系统互证过的）顺着乐曲定下来：没读出的沿用；孤零零一个系统与前后都不同的照前后改；
/// 收得不干净（后面还跟着像升降号的墨）又比邻近系统少几个同种记号的，照邻近的补——少读常见，转调少见且前后系统会一致。
pub(super) fn settle_keys(read: &[Option<(i8, bool)>]) -> Vec<i8> {
    settle(read, |a, b| a.unsigned_abs() < b.unsigned_abs() && (a == 0 || (a > 0) == (b > 0))).into_iter().map(|v| v.unwrap_or(0)).collect()
}

/// 一串按乐曲次序的读数（值, 把握大）定下来：没读出的沿用前一个（开头的取后面第一个）；一段读数夹在两段相同的读数之间、
/// 自己又只有一个或没把握的，照两边改；没把握又是邻段「少读」（`prefix(本段, 邻段)`）的照邻段补；开头结尾孤零零一个没把握的照邻段改。
pub(super) fn settle<T: Copy + PartialEq>(read: &[Option<(T, bool)>], prefix: impl Fn(T, T) -> bool) -> Vec<Option<T>> {
    let n = read.len();
    let mut k: Vec<Option<T>> = read.iter().map(|r| r.map(|x| x.0)).collect();
    let sure: Vec<bool> = read.iter().map(|r| r.is_some_and(|x| x.1)).collect();
    for i in 1..n {
        if k[i].is_none() {
            k[i] = k[i - 1];
        }
    }
    for i in (0..n.saturating_sub(1)).rev() {
        if k[i].is_none() {
            k[i] = k[i + 1];
        }
    }
    if k.iter().any(|v| v.is_none()) {
        return k;
    }
    let mut k: Vec<T> = k.into_iter().map(|v| v.unwrap()).collect();
    for _ in 0..4 {
        let mut changed = false;
        let mut i = 0;
        while i < n {
            let mut j = i;
            while j + 1 < n && k[j + 1] == k[i] {
                j += 1;
            }
            let prev = (i > 0).then(|| k[i - 1]);
            let next = (j + 1 < n).then(|| k[j + 1]);
            let unsure = (i..=j).all(|t| !sure[t]);
            let single = i == j;
            let to = match (prev, next) {
                (Some(p), Some(q)) if p == q && (single || unsure) => Some(p),
                (Some(p), _) if unsure && prefix(k[i], p) => Some(p),
                (_, Some(q)) if unsure && prefix(k[i], q) => Some(q),
                (Some(p), None) if single && unsure => Some(p),
                (None, Some(q)) if single && unsure => Some(q),
                _ => None,
            };
            if let Some(v) = to {
                for t in i..=j {
                    k[t] = v;
                }
                changed = true;
            }
            i = j + 1;
        }
        if !changed {
            break;
        }
    }
    k.into_iter().map(Some).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pf(clef: Clef, lyric: bool, pitch: i32) -> StaffProfile {
        StaffProfile { clef: Some(clef), lyric, pitch: Some(pitch), ..Default::default() }
    }

    #[test]
    fn fewer_rows_follow_clef_lyric_and_range() {
        let (g, f) = (Clef::TREBLE, Clef::BASS);
        // 满档：女高 女低 男 钢右 钢左
        let full = vec![pf(g, true, 36), pf(g, true, 32), pf(f, true, 24), pf(g, false, 31), pf(f, false, 21)];
        // 只印钢琴两行的前奏系统
        let piano = vec![pf(g, false, 30), pf(f, false, 20)];
        // 只印人声三行
        let voice = vec![pf(g, true, 35), pf(g, true, 31), pf(f, true, 25)];
        let got = auto_slots(&[full.clone(), piano, voice, full]);
        assert_eq!(got[1], vec![3, 4]);
        assert_eq!(got[2], vec![0, 1, 2]);
        assert_eq!(got[0], vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn labels_pull_rows_back() {
        let g = Clef::TREBLE;
        let lb = |p: StaffProfile, l: &str| StaffProfile { label: Some(l.into()), ..p };
        let full = vec![lb(pf(g, true, 36), "S1"), lb(pf(g, true, 34), "S2"), lb(pf(g, true, 30), "A")];
        // 女高一部唱低了，音域更像女低，但印着 S1
        let two = vec![lb(pf(g, true, 31), "S1"), pf(g, true, 30)];
        let got = auto_slots(&[full.clone(), full, two]);
        assert_eq!(got[2], vec![0, 2]);
    }
}

#[cfg(test)]
mod key_tests {
    use super::settle_keys;

    #[test]
    fn underread_rows_follow_neighbours() {
        // 孤零零一个系统少读
        assert_eq!(settle_keys(&[Some((-3, true)), Some((-2, true)), Some((-3, true))]), vec![-3, -3, -3]);
        // 开头两个系统收得不干净、少读一个
        assert_eq!(settle_keys(&[Some((-1, false)), Some((-1, false)), Some((-2, true))]), vec![-2, -2, -2]);
        // 真转调：前后各成一段、都收得干净
        assert_eq!(settle_keys(&[Some((-1, true)), Some((-1, true)), Some((2, true)), Some((2, true))]), vec![-1, -1, 2, 2]);
        // 没读出的沿用
        assert_eq!(settle_keys(&[None, Some((1, true)), None]), vec![1, 1, 1]);
    }
}
