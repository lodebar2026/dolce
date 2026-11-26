//! **会话**（计划 §2.8「为手动修改提供支持」）：识别结果留在 Rust，编辑器经命令改，每次只重跑整曲拼接（毫秒级，不重认）。
//!
//! | 操作 | 做法 |
//! |---|---|
//! | 关联表（含「这一行不是谱」） | 改 [`Constraints::slots`]；不要的行从系统里拿掉（`hidden`） |
//! | 系统切分（合并 / 拆开） | 改各页的系统表，关联表回到自动指派 |
//! | 钉住事实（删音、改时值、改音高） | [`Constraints::pins`]，按识别 id |
//! | 换候选 | 取那个事件的第 k 个落选候选，折成钉住的事实 |
//! | 从某处起改谱号 / 调号 / 拍号 | [`Constraints::contexts`] |
//! | 补音（点原图补认） | [`Constraints::adds`]，号码从 `ADD_BASE` 起另发；找头在 `omr-engine::insert`（要回原图） |
//! | 换字（框选重认） | [`Constraints::texts`]，按识别 id；裁图读字在 `omr-engine::region` |
//!
//! 识别 id 在拼接前按识别产物预发（`song/ids.rs`），所以这些操作之后没变的元素号码不变（删掉的留空号）；编辑器按号把手改放回去。
use crate::frame::systems::System;
use crate::page::Page;
use crate::song::{assemble_with, Added, Constraints, Context, Fact, NewNote, Song, ADD_BASE};
use dolce_omr_core::sheet::result::{Rid, RidKind};
use dolce_omr_core::sheet::score::Choice;
use serde::{Deserialize, Serialize};

/// 改系统切分：合并第 `system` 与下一个系统（同一页才行）；在第 `system` 个系统的第 `row` 行之前拆开。系统号按原始切分全曲连续编。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SystemOp {
    Merge { system: usize },
    Split { system: usize, row: usize },
}

/// 一条会话操作（编辑器 / 命令行交来的）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    /// 关联表：各系统（原始切分）各行配到第几个槽位，`null` 即这一行不要。
    Rebuild { slots: Vec<Vec<Option<usize>>> },
    Restructure { change: SystemOp },
    Pin { rid: Rid, fact: Fact },
    /// 撤掉钉在这个 id 上的事实。
    Unpin { rid: Rid },
    Choose { rid: Rid, alt: usize },
    Context { system: usize, context: Context },
    /// 补一个音（点原图补认；找头在 `omr-engine::insert`，这里只记下、发号）。
    Add { note: NewNote },
    /// 换文字（框选重认）：歌词字、文字指示。
    Text { rid: Rid, text: String },
}

pub struct Session {
    pages: Vec<Page>,
    title: Option<String>,
    /// 各页的系统切分（用户改过的；不含「这一行不要」的处理）。
    systems: Vec<Vec<System>>,
    /// 不要的行：(页, 页内谱行)。
    hidden: Vec<(usize, usize)>,
    /// 识别认出的花括号：(页, 上面那行的页内谱行)。拆开时括号断掉，合回来照它补回（不然自动指派与原来不同）。
    braced: Vec<(usize, usize)>,
    c: Constraints,
    song: Song,
}

impl Session {
    pub fn new(pages: Vec<Page>, title: Option<String>) -> Session {
        let systems: Vec<Vec<System>> = pages.iter().map(|p| p.layout.systems.clone()).collect();
        let braced = systems.iter().enumerate().flat_map(|(pn, sys)| sys.iter().flat_map(move |s| s.braces.iter().map(move |&k| (pn, s.staves[k])))).collect();
        let song = assemble_with(&pages, title.clone(), &Constraints::default());
        Session { pages, title, systems, hidden: Vec::new(), braced, c: Constraints::default(), song }
    }

    /// 各结果页（识别产物，会话不改它们）。
    pub fn pages(&self) -> &[Page] {
        &self.pages
    }

    /// 最近补的那个音的识别 id。
    pub fn last_added(&self) -> Option<Rid> {
        self.c.adds.last().map(|a| a.rid)
    }

    pub fn song(&self) -> &Song {
        &self.song
    }

    pub fn constraints(&self) -> &Constraints {
        &self.c
    }

    /// 关联表：各系统（用户切分后的、含不要的行）各行配到的槽位，不要的行为 None。
    pub fn assignment(&self) -> Vec<Vec<Option<usize>>> {
        let mut out = Vec::new();
        let mut n = 0;
        for (pn, sys) in self.systems.iter().enumerate() {
            for s in sys {
                let kept = s.staves.iter().filter(|i| !self.hidden.contains(&(pn, **i))).count();
                let slots = if kept > 0 { self.song.assignment.get(n).cloned().unwrap_or_default() } else { Vec::new() };
                n += (kept > 0) as usize;
                let mut it = slots.into_iter();
                out.push(s.staves.iter().map(|i| if self.hidden.contains(&(pn, *i)) { None } else { it.next() }).collect());
            }
        }
        out
    }

    /// 核对 JSON（[`Song::review_json_with`]）：系统表按会话的切分（含不要的行），关联表即 [`Session::assignment`]。
    pub fn review_json(&self) -> String {
        let systems: Vec<_> = self.systems.iter().enumerate().flat_map(|(pn, sys)| sys.iter().map(move |s| (pn, s.staves.clone()))).collect();
        self.song.review_json_with(&systems, &self.assignment())
    }

    pub fn apply(&mut self, op: Op) -> Result<&Song, String> {
        match op {
            Op::Rebuild { slots } => self.rebuild(&slots)?,
            Op::Restructure { change } => self.restructure(change)?,
            Op::Pin { rid, fact } => self.pin(rid, fact),
            Op::Unpin { rid } => {
                self.c.pins.retain(|p| p.0 != rid);
                self.c.adds.retain(|a| a.rid != rid);
                self.c.texts.retain(|t| t.0 != rid);
            }
            Op::Add { note } => {
                if note.page >= self.pages.len() || note.staff >= self.pages[note.page].layout.staves.len() {
                    return Err("没有这一行谱".into());
                }
                let n = self.c.adds.iter().map(|a| a.rid.n).max().unwrap_or(ADD_BASE) + 1;
                self.c.adds.push(Added { rid: Rid { kind: RidKind::Note, n }, note });
            }
            Op::Text { rid, text } => {
                self.c.texts.retain(|t| t.0 != rid);
                self.c.texts.push((rid, text));
            }
            Op::Choose { rid, alt } => {
                let e = self.song.score.parts.iter().flat_map(|p| p.measures.iter()).flat_map(|m| m.events.iter()).find(|e| e.src.iter().any(|h| h.src.rid == Some(rid))).ok_or(format!("没有 {rid}"))?;
                let a = e.alts.get(alt).ok_or(format!("{rid} 没有第 {alt} 个候选"))?;
                let fact = match a.choice {
                    Choice::Duration { ntype, dots } => Fact::Duration { ntype, dots },
                    Choice::Drop => Fact::Drop,
                };
                self.pin(rid, fact);
            }
            Op::Context { system, context } => self.c.contexts.push((system, context)),
        }
        self.reassemble();
        Ok(&self.song)
    }

    /// 钉一条事实：同一个 id 上同一种事实（删 / 时值 / 音高）后钉的压前钉的，不同种的并存（改了音高又改时值两条都留）；删掉压掉别的。
    fn pin(&mut self, rid: Rid, fact: Fact) {
        let kind = |f: &Fact| std::mem::discriminant(f);
        self.c.pins.retain(|p| p.0 != rid || (kind(&p.1) != kind(&fact) && fact != Fact::Drop && p.1 != Fact::Drop));
        self.c.pins.push((rid, fact));
    }

    fn rebuild(&mut self, slots: &[Vec<Option<usize>>]) -> Result<(), String> {
        let shape: Vec<usize> = self.systems.iter().flatten().map(|s| s.staves.len()).collect();
        if slots.len() != shape.len() || slots.iter().zip(&shape).any(|(a, &n)| a.len() != n) {
            return Err("关联表的形状与系统对不上".into());
        }
        self.hidden.clear();
        let mut kept: Vec<Vec<usize>> = Vec::new();
        let mut k = 0;
        for (pn, sys) in self.systems.iter().enumerate() {
            for s in sys {
                let row: Vec<usize> = s.staves.iter().zip(&slots[k]).filter_map(|(i, v)| match v {
                    Some(v) => Some(*v),
                    None => {
                        self.hidden.push((pn, *i));
                        None
                    }
                }).collect();
                if !row.is_empty() {
                    kept.push(row);
                }
                k += 1;
            }
        }
        self.c.slots = Some(kept);
        Ok(())
    }

    fn restructure(&mut self, op: SystemOp) -> Result<(), String> {
        let at = |n: usize| -> Option<(usize, usize)> {
            let mut k = n;
            for (pn, sys) in self.systems.iter().enumerate() {
                if k < sys.len() {
                    return Some((pn, k));
                }
                k -= sys.len();
            }
            None
        };
        match op {
            SystemOp::Merge { system } => {
                let (pa, a) = at(system).ok_or("没有这个系统")?;
                let (pb, _) = at(system + 1).ok_or("后面没有系统")?;
                if pa != pb {
                    return Err("跨页的两个系统不能合并".into());
                }
                let next = self.systems[pa].remove(a + 1);
                let mut m = merge_systems(&self.systems[pa][a], &next);
                // 接缝处的两行原来被花括号括着（先拆后合）就补回
                let seam = self.systems[pa][a].staves.len();
                if self.braced.contains(&(pa, m.staves[seam - 1])) {
                    m.braces.push(seam - 1);
                    m.braces.sort_unstable();
                }
                self.systems[pa][a] = m;
            }
            SystemOp::Split { system, row } => {
                let (p, a) = at(system).ok_or("没有这个系统")?;
                let (x, y) = split_system(&self.systems[p][a], row).ok_or("拆分的位置不对")?;
                self.systems[p][a] = x;
                self.systems[p].insert(a + 1, y);
            }
        }
        // 系统变了，关联表回到自动指派；上下文按系统号记的跟着就不准了，一并清掉
        self.c.slots = None;
        self.c.contexts.clear();
        Ok(())
    }

    fn reassemble(&mut self) {
        for (pn, page) in self.pages.iter_mut().enumerate() {
            page.layout.systems = self.systems[pn]
                .iter()
                .filter_map(|s| without(s, &self.hidden.iter().filter(|h| h.0 == pn).map(|h| h.1).collect::<Vec<_>>()))
                .collect();
        }
        self.song = assemble_with(&self.pages, self.title.clone(), &self.c);
    }
}

/// 两个系统并成一个（花括号各自留着，跨两个系统的那一处不算）。
pub fn merge_systems(a: &System, b: &System) -> System {
    let n = a.staves.len();
    System { staves: a.staves.iter().chain(&b.staves).copied().collect(), linked: true, braces: a.braces.iter().copied().chain(b.braces.iter().map(|k| k + n)).collect() }
}

/// 在第 `row` 行之前拆开（`row` 在 1..行数）。
pub fn split_system(s: &System, row: usize) -> Option<(System, System)> {
    if row == 0 || row >= s.staves.len() {
        return None;
    }
    let part = |r: std::ops::Range<usize>| {
        let staves = s.staves[r.clone()].to_vec();
        System { linked: staves.len() > 1, braces: s.braces.iter().filter(|&&k| k >= r.start && k + 1 < r.end).map(|k| k - r.start).collect(), staves }
    };
    Some((part(0..row), part(row..s.staves.len())))
}

/// 拿掉不要的行（页内谱行下标）；拿光了回 None。花括号只留两行都还在的。
fn without(s: &System, hidden: &[usize]) -> Option<System> {
    if !s.staves.iter().any(|i| hidden.contains(i)) {
        return Some(s.clone());
    }
    let keep: Vec<usize> = (0..s.staves.len()).filter(|&k| !hidden.contains(&s.staves[k])).collect();
    if keep.is_empty() {
        return None;
    }
    let braces = s.braces.iter().filter_map(|&k| {
        let (a, b) = (keep.iter().position(|&x| x == k)?, keep.iter().position(|&x| x == k + 1)?);
        (b == a + 1).then_some(a)
    });
    Some(System { staves: keep.iter().map(|&k| s.staves[k]).collect(), linked: keep.len() > 1, braces: braces.collect() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sys(staves: &[usize], braces: &[usize]) -> System {
        System { staves: staves.to_vec(), linked: staves.len() > 1, braces: braces.to_vec() }
    }

    #[test]
    fn split_then_merge_round_trips() {
        let s = sys(&[3, 4, 5, 6], &[2]);
        let (a, b) = split_system(&s, 2).unwrap();
        assert_eq!((a.staves.clone(), b.staves.clone(), b.braces.clone()), (vec![3, 4], vec![5, 6], vec![0]));
        assert_eq!(merge_systems(&a, &b), s);
        assert!(split_system(&s, 0).is_none() && split_system(&s, 4).is_none());
    }

    #[test]
    fn hiding_rows_keeps_whole_braces() {
        let s = sys(&[0, 1, 2, 3], &[2]);
        assert_eq!(without(&s, &[1]), Some(sys(&[0, 2, 3], &[1])));
        assert_eq!(without(&s, &[3]), Some(sys(&[0, 1, 2], &[])));
        assert_eq!(without(&sys(&[7], &[]), &[7]), None);
    }

    #[test]
    fn ops_parse_from_json() {
        let ops = [
            r#"{"op":"rebuild","slots":[[0,null,1]]}"#,
            r#"{"op":"restructure","change":{"kind":"split","system":2,"row":1}}"#,
            r#"{"op":"pin","rid":"omr12","fact":{"fact":"duration","ntype":"Half","dots":1}}"#,
            r#"{"op":"choose","rid":"omr3","alt":0}"#,
            r#"{"op":"context","system":4,"context":{"what":"key","fifths":-2}}"#,
        ];
        for o in ops {
            serde_json::from_str::<Op>(o).unwrap_or_else(|e| panic!("{o}: {e}"));
        }
    }
}
