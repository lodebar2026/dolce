//! **满拍验收与候选组合**（两条路线共用的纯逻辑）：一个小节里一行谱的各个拍点排成时间线，看拍数满不满；
//! 不满时在各元素的备选（改时值、删掉）里找一组花费最小、使本小节满拍、且与同系统别的行拍位对得上的。
//!
//! 时间线按「至多两个声部」排：同一拍点上并排两个元素的各归一个声部；单独一个元素归当时空着的声部，两个声部都空着就两边共用
//! （合唱谱两个声部同节奏时共用一根干、一个休止）。单声部的行自然退化成逐个相加。

/// 与别的行拍位对不上一处，折成这么多花费。
const ALIGN_COST: f64 = 0.4;
/// 备选多过这么多个的小节只试单个改动（两两组合太多）。
const PAIR_CAP: usize = 64;

/// 一个备选：改成这个时值（`None` 即删掉这个元素），花费越大越不情愿。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Alt {
    pub dur: Option<u32>,
    pub cost: f64,
}

/// 小节里的一个元素（和弦或休止）。
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub x: f64,
    pub y: f64,
    /// 占多少份。
    pub dur: u32,
    /// 声部线索：符干朝上（上声部）/ 朝下；没有干的为 None，按上下位置分。
    pub up: Option<bool>,
    pub alts: Vec<Alt>,
}

/// 一行谱一个小节的时间线。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Line {
    /// 各拍点 `(x, 起拍时刻)`。
    pub onsets: Vec<(f64, u32)>,
    /// 两个声部各排到哪儿。
    pub end: [u32; 2],
    /// 排不通：一个声部还占着，同一拍点却并排来了两个元素。
    pub clash: bool,
}

impl Line {
    pub fn fits(&self, want: u32) -> bool {
        !self.clash && self.end == [want, want]
    }

    /// 各声部排到同一处（不一定是满拍）；回那一处。
    pub fn even(&self) -> Option<u32> {
        (!self.clash && self.end[0] == self.end[1]).then_some(self.end[0])
    }

    /// 与别的行的拍点 `peers` 对不上的处数：横向相隔不到 `same_dx` 的拍点，起拍时刻不同。
    pub fn misaligned(&self, peers: &[(f64, u32)], same_dx: f64) -> usize {
        self.onsets.iter().filter(|(x, t)| peers.iter().any(|(px, pt)| (x - px).abs() < same_dx && pt != t)).count()
    }
}

/// 排时间线。`items`：`(x, y, 份数, 声部线索)`，按 x 排好；横向相隔不到 `same_dx` 的算同一拍点。
pub fn timeline(items: &[(f64, f64, u32, Option<bool>)], same_dx: f64) -> Line {
    let mut line = Line::default();
    let mut i = 0;
    while i < items.len() {
        let mut j = i + 1;
        while j < items.len() && items[j].0 - items[j - 1].0 < same_dx {
            j += 1;
        }
        let mut g: Vec<&(f64, f64, u32, Option<bool>)> = items[i..j].iter().collect();
        i = j;
        // 朝上的在前、朝下的在后，没线索的按上下位置
        g.sort_by(|a, b| {
            let k = |v: &Option<bool>| match v {
                Some(true) => 0,
                None => 1,
                Some(false) => 2,
            };
            k(&a.3).cmp(&k(&b.3)).then(a.1.total_cmp(&b.1))
        });
        let (a, b) = (g[0], g[g.len() - 1]);
        let t = line.end[0].min(line.end[1]);
        let free = [line.end[0] == t, line.end[1] == t];
        line.onsets.push((g.iter().map(|e| e.0).sum::<f64>() / g.len() as f64, t));
        // 并排两个、线索又相同的（都朝上）当一个元素，取短的
        let two = g.len() >= 2 && !(a.3.is_some() && a.3 == b.3);
        match (two, free) {
            (true, [true, true]) => {
                line.end[0] += a.2;
                line.end[1] += b.2;
            }
            (false, [true, true]) => {
                let d = g.iter().map(|e| e.2).min().unwrap();
                line.end[0] += d;
                line.end[1] += d;
            }
            (two, _) => {
                line.clash |= two;
                let d = g.iter().map(|e| e.2).min().unwrap();
                line.end[if free[0] { 0 } else { 1 }] += d;
            }
        }
    }
    line
}

/// 一组取舍的结果。
#[derive(Clone, Debug, PartialEq)]
pub struct Solved {
    /// 各元素取了第几个备选（`None` 即原判）。
    pub pick: Vec<Option<usize>>,
    pub cost: f64,
    pub line: Line,
}

fn line_of(items: &[Item], pick: &[Option<usize>], same_dx: f64) -> Line {
    let v: Vec<(f64, f64, u32, Option<bool>)> = items
        .iter()
        .zip(pick)
        .filter_map(|(it, p)| match p {
            None => Some((it.x, it.y, it.dur, it.up)),
            Some(k) => it.alts[*k].dur.map(|d| (it.x, it.y, d, it.up)),
        })
        .collect();
    timeline(&v, same_dx)
}

/// 原判的时间线。
pub fn base_line(items: &[Item], same_dx: f64) -> Line {
    line_of(items, &vec![None; items.len()], same_dx)
}

/// 在备选里找一组使本小节满 `want` 份的取舍：至多动两个元素，花费（备选花费 + 与 `peers` 对不上的处数折价）最小的那组。
/// 原判已经满拍的不该来问；找不到回 None（保持原判、由调用方记可疑）。
pub fn solve(items: &[Item], want: u32, same_dx: f64, peers: &[(f64, u32)]) -> Option<Solved> {
    let alts: Vec<(usize, usize, f64)> = items.iter().enumerate().flat_map(|(i, it)| it.alts.iter().enumerate().map(move |(k, a)| (i, k, a.cost))).collect();
    let mut best: Option<Solved> = None;
    let mut pick = vec![None; items.len()];
    let consider = |pick: &[Option<usize>], cost: f64, best: &mut Option<Solved>| {
        if best.as_ref().is_some_and(|b| b.cost <= cost) {
            return;
        }
        let line = line_of(items, pick, same_dx);
        if !line.fits(want) {
            return;
        }
        let cost = cost + ALIGN_COST * line.misaligned(peers, same_dx) as f64;
        if best.as_ref().is_none_or(|b| cost < b.cost) {
            *best = Some(Solved { pick: pick.to_vec(), cost, line });
        }
    };
    for (n, &(i, k, c)) in alts.iter().enumerate() {
        pick[i] = Some(k);
        consider(&pick, c, &mut best);
        if alts.len() <= PAIR_CAP {
            for &(i2, k2, c2) in &alts[n + 1..] {
                if i2 == i {
                    continue;
                }
                pick[i2] = Some(k2);
                consider(&pick, c + c2, &mut best);
                pick[i2] = None;
            }
        }
        pick[i] = None;
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn it(x: f64, dur: u32, up: Option<bool>) -> (f64, f64, u32, Option<bool>) {
        (x, if up == Some(false) { 10.0 } else { 0.0 }, dur, up)
    }

    #[test]
    fn single_voice_adds_up() {
        let l = timeline(&[it(0.0, 24, Some(true)), it(10.0, 12, Some(true)), it(20.0, 12, Some(true)), it(30.0, 48, None)], 3.0);
        assert!(l.fits(96));
        assert_eq!(l.onsets.iter().map(|o| o.1).collect::<Vec<_>>(), vec![0, 24, 36, 48]);
    }

    #[test]
    fn two_voices_interleave() {
        // 上声部：附点四分 + 八分；下声部：四分 + 四分
        let l = timeline(&[it(0.0, 36, Some(true)), it(1.0, 24, Some(false)), it(10.0, 24, Some(false)), it(15.0, 12, Some(true))], 3.0);
        assert!(l.fits(48));
        assert_eq!(l.onsets.iter().map(|o| o.1).collect::<Vec<_>>(), vec![0, 24, 36]);
    }

    #[test]
    fn solve_picks_cheapest_fix() {
        let mk = |x: f64, dur: u32, alts: Vec<Alt>| Item { x, y: 0.0, dur, up: Some(true), alts };
        // 3/4：四分 + 四分 + 八分，差一个八分；末一个改四分最便宜
        let items = vec![
            mk(0.0, 24, vec![Alt { dur: Some(36), cost: 1.0 }]),
            mk(10.0, 24, vec![Alt { dur: Some(36), cost: 1.0 }]),
            mk(20.0, 12, vec![Alt { dur: Some(24), cost: 0.8 }, Alt { dur: None, cost: 2.0 }]),
        ];
        assert!(!base_line(&items, 3.0).fits(72));
        let s = solve(&items, 72, 3.0, &[]).unwrap();
        assert_eq!(s.pick, vec![None, None, Some(0)]);
        // 别的行在 x=10 处起拍时刻是 36：改第一个成附点才对得上
        let s = solve(&items, 72, 3.0, &[(10.0, 36)]).unwrap();
        assert_eq!(s.pick, vec![Some(0), None, None]);
    }
}
