//! 成书重排：断句的断点换成「新行从哪个元素起」、段落词挂到和弦上（TS `jianpu/applybreaks.ts` 里改模型的那两个照搬）。
//! 断句输入与文档的和弦按元素 id 对上（`ids` 是拍平下标 → 元素 id，同 `phrasedoc::phrase_part_of_doc` 回的那张表）。

use dolce_model::breaks::LineStart;
use dolce_model::{Element, ElementId, Measure, Song};
use dolce_play::phrase::PhraseBreaks;
use dolce_play::phraseinput::PhrasePart;

use crate::phrasesong::{fail, ViewResult};

/// 写断点的选项（TS `ApplyBreakOptions`）。
#[derive(Debug, Clone, Copy)]
pub struct ApplyBreakOptions {
    /// 每页几行；0 = 不按行数换页（成书一页装多少行交给排版按页高定）
    pub lines_per_page: f64,
    /// 段落起点另起一页
    pub section_new_page: bool,
    /// 采用行内断点
    pub use_mid_breaks: bool,
}

impl Default for ApplyBreakOptions {
    fn default() -> Self {
        ApplyBreakOptions { lines_per_page: 4.0, section_new_page: false, use_mid_breaks: true }
    }
}

/// 小节里第 `from` 个元素起第一个正经和弦（不是倚音）的 id：新行从它起
fn chord_id_from(m: &Measure, from: usize) -> Option<ElementId> {
    m.elements.iter().skip(from).find_map(|el| match el {
        Element::Chord(c) if c.grace.is_none() => Some(c.id),
        _ => None,
    })
}

/// 断句的断点 → 行首（交 `dolce_model::breaks::apply_breaks`，`mid: inline`、`pages: write`，**替换**原有换行），外加行数、页数。
/// 小节数对不上、断点和弦在文档里找不到时回错（同 TS 抛错）。
pub fn phrase_line_starts(song: &Song, input: &PhrasePart, ids: &[Option<ElementId>], breaks: &PhraseBreaks, opt: ApplyBreakOptions) -> ViewResult<(Vec<LineStart>, f64, f64)> {
    let empty = Vec::new();
    let measures = song.parts.first().map_or(&empty, |p| &p.measures);
    if measures.len() != input.measures.len() {
        return fail(&format!("断句输入与文档小节数对不上：{} / {}", input.measures.len(), measures.len()));
    }
    let mut starts: Vec<LineStart> = Vec::new();
    let mut lines = 0.0;
    let mut pages = 1.0;
    let mut just_paged = false;
    let mut brk = |id: Option<ElementId>, force_page: bool, starts: &mut Vec<LineStart>| {
        let Some(id) = id else { return };
        lines += 1.0;
        let page = force_page || (opt.lines_per_page > 0.0 && !just_paged && lines % opt.lines_per_page == 0.0);
        starts.push(LineStart { id, page });
        if page {
            pages += 1.0;
            lines = 0.0;
        }
        just_paged = page;
    };
    let mut flat = 0usize;
    for (i, m) in measures.iter().enumerate() {
        let n = input.measures[i].chords.len();
        if opt.use_mid_breaks {
            for k in flat..flat + n {
                let cut = breaks.section_cut_chords.contains(&k);
                if !breaks.mid_breaks.contains(&k) && !cut {
                    continue;
                }
                let id = ids.get(k).copied().flatten();
                let Some(at) = id.and_then(|id| m.elements.iter().position(|el| el.id() == id)) else {
                    return fail(&format!("断句输入的和弦在文档里找不到（id {}）", id.map_or("undefined".to_string(), |x| x.to_string())));
                };
                brk(chord_id_from(m, at + 1), opt.section_new_page && cut, &mut starts);
            }
        }
        flat += n;
        let next = i + 1;
        if next < measures.len() && (breaks.measure_breaks.contains(&next) || breaks.section_starts.contains(&next)) {
            brk(chord_id_from(&measures[next], 0), opt.section_new_page && breaks.section_starts.contains(&next), &mut starts);
        }
    }
    Ok((starts, lines, pages))
}

/// 成书的段落词（原书印在和弦带里的「（副歌）」）：按原书音符序号（数正经和弦、休止也算、倚音不算）挂到和弦上；
/// 副歌那一条优先挂到断句输入里**副歌的起句**（重排后序号常差几个音，023 首曾落在副歌前一行）。回 `(元素 id, 词)`，按写入次序。
pub fn section_word_targets(song: &Song, input: &PhrasePart, ids: &[Option<ElementId>], rows: &[(String, f64)]) -> Vec<(ElementId, String)> {
    if rows.is_empty() {
        return vec![];
    }
    let chords: Vec<ElementId> = song
        .parts
        .first()
        .map(|p| p.measures.iter().flat_map(|m| m.elements.iter()).filter_map(|el| el.as_chord().filter(|c| c.grace.is_none()).map(|c| c.id)).collect())
        .unwrap_or_default();
    // 头一个带副歌词、且对得上元素 id 的和弦
    let refrain_id = input
        .flat_chords()
        .enumerate()
        .filter(|(_, c)| c.notes.first().is_some_and(|n| n.lyrics.iter().any(|l| l.refrain && !l.text.is_empty())))
        .find_map(|(k, _)| ids.get(k).copied().flatten());
    let refrain_at = refrain_id.and_then(|id| chords.iter().position(|&c| c == id));
    let mut out = Vec::new();
    for (text, ordinal) in rows {
        let at = match refrain_at {
            Some(r) if text.contains("副歌") => Some(r),
            _ => {
                let a = ordinal.min(chords.len() as f64 - 1.0);
                dolce_base::js::index(a)
            }
        };
        if let Some(&id) = at.and_then(|a| chords.get(a)) {
            out.push((id, text.clone()));
        }
    }
    out
}
