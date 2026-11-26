//! 排版的输入（照 `layout/jianpu/input.ts` 与 `jianpu/slots.ts::docView` 门面建表那一段）：
//! [`dolce_model::view::slots::doc_view`] 的行视图，每行另带三张身份表——TS 按对象身份查的 `idOf` / `syllableOwner`
//! 在这里按下标平行存：`ids[i]`（行内元素）、`sub_ids[i][k]`（并排块 / 伴奏层里的元素，只收非负）、`owners[line][k]`（歌词音节归属）。
//! 投影档逐遍展开（`expand.rs`）造的新行照样带这三张表与各符号的遍号（TS `passesOfRow`）。

use std::rc::Rc;

use dolce_model as dm;
use dolce_model::view::ast::{Metadata, MusicElement, ScoreLine, TextLine};
use dolce_model::view::slots::{doc_view, SlotRef};

/// 一份文档的排版行视图（TS `DocView`）
#[derive(Clone, Debug)]
pub struct LDoc {
    pub songs: Vec<LSong>,
}

#[derive(Clone, Debug)]
pub struct LSong {
    pub index: usize,
    pub metadata: Metadata,
    pub pages: Vec<LPage>,
    /// 行视图指的那份曲子（投影改过的是投影后那份）
    pub song: Rc<dm::Song>,
    /// 投影档各遍的段落出现表；简谱档为 None
    pub proj: Option<Rc<Vec<ProjPass>>>,
}

/// 投影档一遍的段落出现表（`LaidInfo.projPasses`）：界面在谱面上增删版面断点时，由点中的音（`Identity.slot`）认出是哪一段第几次
#[derive(Clone, Debug, serde::Serialize)]
pub struct ProjPass {
    /// 第几遍（从 1 起，同 `%%layout … pass=`）
    pub no: u32,
    /// 这一遍各段的每次出现：(段名〔第一个段落标记之前为空串〕, 这一遍里第几次, 首符号, 末符号)
    pub runs: Vec<(String, u32, u32, u32)>,
    /// 各符号：音取它的元素 id，别的为 null
    pub ids: Vec<Option<i64>>,
}

#[derive(Clone, Debug)]
pub struct LPage {
    pub index: usize,
    pub groups: Vec<Rc<LGroup>>,
}

/// 一个系统（TS `SystemView` / `VoiceGroup`）
#[derive(Clone, Debug)]
pub struct LGroup {
    pub index: usize,
    pub system: f64,
    pub texts: Vec<TextLine>,
    pub voices: Vec<Rc<LRow>>,
}

/// 一行（TS `RowView`）：`ScoreLine` + 来源 + 身份表
#[derive(Clone, Debug)]
pub struct LRow {
    pub line: ScoreLine,
    pub part: usize,
    pub measures: Vec<usize>,
    pub refs: Vec<SlotRef>,
    /// 与 `line.elements` 平行：元素 id（`idOf`，可为补拍位的负临时号）
    pub ids: Vec<Option<i64>>,
    /// 与 `line.elements` 平行：内联层里各元素的 id（非负的才有，同 TS 只登记模型里有的）；不是内联层为空
    pub sub_ids: Vec<Vec<Option<i64>>>,
    /// 与 `line.lyrics` 平行：各音节的归属音 id（`syllableOwner`）
    pub owners: Vec<Vec<Option<i64>>>,
    /// 投影档：各符号所在那一遍的遍号（`passesOfRow`，与 `line.elements` 平行）；简谱档为 None
    pub passes: Option<Vec<f64>>,
    /// 投影档：(第几遍, 本行第一个符号在这一遍里的下标)；元素 k 是这一遍第 首+k 个符号
    pub slot0: Option<(u32, u32)>,
}

impl LRow {
    /// 由一行与 `ids` 建 `sub_ids` / `owners`（规则同 TS `docView`）
    pub fn new(line: ScoreLine, part: usize, measures: Vec<usize>, refs: Vec<SlotRef>, ids: Vec<Option<i64>>) -> LRow {
        let sub_ids = line
            .elements
            .iter()
            .map(|el| match el {
                MusicElement::InlineLayer(l) => (0..l.elements.len())
                    .map(|k| l.ids.as_ref().and_then(|v| v.get(k).copied().flatten()).filter(|id| *id >= 0))
                    .collect(),
                _ => vec![],
            })
            .collect();
        let anchors: Vec<usize> = line
            .elements
            .iter()
            .enumerate()
            .filter(|(_, el)| match el {
                MusicElement::Note(n) => n.lyric_anchor,
                MusicElement::Sustain(s) => s.lyric_anchor,
                _ => false,
            })
            .map(|(i, _)| i)
            .collect();
        let owners = line
            .lyrics
            .iter()
            .map(|l| (0..l.syllables.len()).map(|k| anchors.get(k).and_then(|&i| ids.get(i).copied().flatten())).collect())
            .collect();
        LRow { line, part, measures, refs, ids, sub_ids, owners, passes: None, slot0: None }
    }

    /// 行内第 `i` 个元素的 id
    pub fn id_at(&self, i: i64) -> Option<i64> {
        if i < 0 {
            return None;
        }
        self.ids.get(i as usize).copied().flatten()
    }
}

/// `ScoreDoc` → 排版输入（`originalInputOf`）
pub fn input_of(doc: &dm::ScoreDoc) -> LDoc {
    let view = doc_view(doc, None);
    let songs = view
        .songs
        .into_iter()
        .enumerate()
        .map(|(i, sv)| {
            let song = Rc::new(sv.song.clone().unwrap_or_else(|| doc.songs[i].clone()));
            let pages = sv
                .pages
                .into_iter()
                .map(|pg| LPage {
                    index: pg.index,
                    groups: pg
                        .groups
                        .into_iter()
                        .map(|g| {
                            Rc::new(LGroup {
                                index: g.index,
                                system: g.system,
                                texts: g.texts,
                                voices: g
                                    .voices
                                    .into_iter()
                                    .map(|rv| {
                                        let ids = rv.refs.iter().map(|r| r.id).collect();
                                        Rc::new(LRow::new(rv.line, rv.part, rv.measures, rv.refs, ids))
                                    })
                                    .collect(),
                            })
                        })
                        .collect(),
                })
                .collect();
            LSong { index: sv.index, metadata: sv.metadata, pages, song, proj: None }
        })
        .collect();
    LDoc { songs }
}
