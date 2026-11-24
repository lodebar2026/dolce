//! 约束（计划 §2.8「为手动修改提供支持」）：用户在编辑器里定了的事，作为整曲拼接与满拍裁决的硬输入。
//!
//! - **关联表**（`slots`）：各系统各行配到哪个槽位，给了就不自动指派。
//! - **钉住的事实**（`pins`，按识别 id）：删掉、改时值、改音高。落在预发号之后的音符上（号码不受影响），被钉的和弦 / 休止标 `pinned`，
//!   满拍裁决不再给它出候选；同小节别的元素照常按新的约束重新裁决。
//! - **从某个系统起改的上下文**（`contexts`）：谱号（对一个槽位）、调号、拍号，后面的系统一路照它，直到下一处改的。
//! - **补的音**（`adds`，点原图补认）：号码从 [`ADD_BASE`] 起另发，不挪预发号；补的音标 `pinned`。
//! - **改的字**（`texts`，框选重认）：按识别 id 换歌词字、文字指示的文字，拼完整曲后换。
use super::*;
use crate::notes::heads::{Head, HeadKind};
use crate::notes::stems::Stem;
use crate::notes::Chord;
use dolce_omr_sheet::music::Time;
use dolce_omr_sheet::score::NoteType;
use serde::{Deserialize, Serialize};

/// 钉住的事实。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "fact", rename_all = "camelCase")]
pub enum Fact {
    /// 删掉（不是音 / 不是休止）。和弦里的一个头只删那个头。
    Drop,
    /// 改时值（整个和弦 / 休止）。
    Duration { ntype: NoteType, dots: u8 },
    /// 改音高（这一个头）。
    Pitch { pitch: Pitch },
}

/// 从某个系统起改的上下文。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "what", rename_all = "camelCase")]
pub enum Context {
    /// 某个槽位（声部行）的谱号。
    Clef { slot: usize, clef: Clef },
    Key { fifths: i8 },
    Time { time: Time },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Constraints {
    /// 关联表：各系统各行配到第几个槽位（行数要与系统对上，否则不用）。
    #[serde(default)]
    pub slots: Option<Vec<Vec<usize>>>,
    #[serde(default)]
    pub pins: Vec<(Rid, Fact)>,
    /// （从全曲第几个系统起，改成什么）。
    #[serde(default)]
    pub contexts: Vec<(usize, Context)>,
    #[serde(default)]
    pub adds: Vec<Added>,
    #[serde(default)]
    pub texts: Vec<(Rid, String)>,
}

/// 补的音的识别 id 从这个号起（预发号是按识别产物顺序编的，一首曲子到不了这么多）。
pub const ADD_BASE: u32 = 1_000_000;

/// 一个补的音。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Added {
    pub rid: Rid,
    #[serde(flatten)]
    pub note: NewNote,
}

/// 补的音的内容（点原图补认）：落在哪一页（结果页下标）哪一行谱、头的位置与音级、头型、杠尾、附点，有干就带上。坐标是页内工作坐标。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNote {
    pub page: usize,
    pub staff: usize,
    pub x: f64,
    pub y: f64,
    pub pos: i32,
    pub kind: HeadKind,
    #[serde(default)]
    pub tails: u8,
    #[serde(default)]
    pub dots: u8,
    #[serde(default)]
    pub stem: Option<Stem>,
}

/// 补的音落进预发号之后的音符（各页各行）。
pub(super) fn apply_adds(notes: &mut [Vec<RowNotes>], adds: &[Added]) {
    for Added { rid, note: a } in adds {
        let Some(row) = notes.get_mut(a.page).and_then(|p| p.get_mut(a.staff)) else { continue };
        let head = Head { staff: a.staff, x: a.x, y: a.y, pos: a.pos, kind: a.kind, fill: 1.0, score: 1.0, acc: None, rid: Some(*rid) };
        row.chords.push(Chord { x: a.x, heads: vec![head], stem: a.stem, tails: a.tails, beamed: false, dots: a.dots, arts: Vec::new(), tuplet: None, pinned: true, graces: Vec::new() });
        row.chords.sort_by(|a, b| a.x.total_cmp(&b.x));
    }
}

/// 改的字：歌词字、文字指示按识别 id 换文字。
pub(super) fn apply_texts(score: &mut dolce_omr_sheet::score::Score, texts: &[(Rid, String)]) {
    use dolce_omr_sheet::score::Dir;
    if texts.is_empty() {
        return;
    }
    let find = |r: Option<Rid>| r.and_then(|r| texts.iter().rev().find(|t| t.0 == r)).map(|t| t.1.clone());
    for e in score.parts.iter_mut().flat_map(|p| p.measures.iter_mut()).flat_map(|m| m.events.iter_mut()) {
        for l in e.lyrics.iter_mut() {
            if let Some(t) = find(l.src.rid) {
                l.text = t;
            }
        }
        for d in e.pre.iter_mut() {
            if let (Dir::Words { text, .. }, Some(t)) = (&mut d.dir, find(d.src.rid)) {
                *text = t;
            }
        }
    }
}

impl Constraints {
    /// 第 `sys` 个系统上现行的上下文改动里，满足 `pick` 的那个（后改的压前改的）。
    fn latest<T>(&self, sys: usize, pick: impl Fn(&Context) -> Option<T>) -> Option<T> {
        let mut v: Vec<&(usize, Context)> = self.contexts.iter().filter(|c| c.0 <= sys).collect();
        v.sort_by_key(|c| c.0);
        v.iter().rev().find_map(|c| pick(&c.1))
    }

    pub(super) fn key_at(&self, sys: usize) -> Option<i8> {
        self.latest(sys, |c| if let Context::Key { fifths } = c { Some(*fifths) } else { None })
    }

    pub(super) fn clef_at(&self, sys: usize, slot: usize) -> Option<Clef> {
        self.latest(sys, |c| match c {
            Context::Clef { slot: s, clef } if *s == slot => Some(*clef),
            _ => None,
        })
    }

    /// 正好在第 `sys` 个系统上改的拍号（拍号只在改的那一处印）。
    pub(super) fn time_at(&self, sys: usize) -> Option<Time> {
        self.contexts.iter().rev().find_map(|c| match c {
            (s, Context::Time { time }) if *s == sys => Some(*time),
            _ => None,
        })
    }
}

/// 把钉住的事实落到预发号之后的音符上（`notes`：各页各行，与 `pages` 同序）。
pub(super) fn apply_pins(pages: &[Page], notes: &mut [Vec<RowNotes>], pins: &[(Rid, Fact)]) {
    for &(rid, fact) in pins {
        'found: for (pn, page) in pages.iter().enumerate() {
            for (i, row) in notes[pn].iter_mut().enumerate() {
                if let Some(k) = row.rests.iter().position(|r| r.rid == Some(rid)) {
                    match fact {
                        Fact::Drop => {
                            row.rests.remove(k);
                        }
                        Fact::Duration { ntype, dots } => {
                            let r = &mut row.rests[k];
                            (r.ntype, r.dots, r.pinned) = (ntype, dots, true);
                        }
                        Fact::Pitch { .. } => {}
                    }
                    break 'found;
                }
                let Some((c, h)) = row.chords.iter().enumerate().find_map(|(c, ch)| ch.heads.iter().position(|h| h.rid == Some(rid)).map(|h| (c, h))) else { continue };
                match fact {
                    Fact::Drop => {
                        let ch = &mut row.chords[c];
                        ch.heads.remove(h);
                        ch.pinned = true;
                        if ch.heads.is_empty() {
                            row.chords.remove(c);
                        }
                    }
                    Fact::Duration { ntype, dots } => {
                        let ch = &mut row.chords[c];
                        let (kind, tails) = match ntype {
                            NoteType::Whole => (HeadKind::Whole, 0),
                            NoteType::Half => (HeadKind::Half, 0),
                            NoteType::Quarter => (HeadKind::Filled, 0),
                            NoteType::Eighth => (HeadKind::Filled, 1),
                            NoteType::N16th => (HeadKind::Filled, 2),
                            NoteType::N32nd => (HeadKind::Filled, 3),
                        };
                        ch.heads.iter_mut().for_each(|h| h.kind = kind);
                        (ch.tails, ch.dots, ch.pinned) = (tails, dots, true);
                    }
                    Fact::Pitch { pitch } => {
                        let clef = page.attrs[i].clef.unwrap_or(Clef::TREBLE);
                        let key = page.attrs[i].key.unwrap_or_default();
                        let st = &page.layout.staves[i];
                        let ch = &mut row.chords[c];
                        let hd = &mut ch.heads[h];
                        hd.pos = clef.pos_of(pitch);
                        hd.y = st.y_of(hd.x, hd.pos as f64);
                        // 与调号不同的升降记成明印的临时记号
                        hd.acc = (pitch.alter != key.alter_of(pitch.step)).then_some(pitch.alter);
                        ch.pinned = true;
                    }
                }
                break 'found;
            }
        }
    }
}
