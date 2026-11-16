//! 简谱来源 → MusicXML 形状的投影（同 `src/model/xmlproject.ts`）。**M2 第 5 步移植中**：现在只有入口判断。

use crate::doc::*;
use dolce_base::Msg;
use std::borrow::Cow;
use std::collections::HashSet;

/// 已是 MusicXML 形状（有声部首小节写了 `divisions`）：投影原样返回
pub fn is_xml_shaped(song: &Song) -> bool {
    song.parts.iter().any(|p| p.measures.first().and_then(|m| m.attrs.as_ref()).and_then(|a| a.divisions).is_some())
}

/// 源格式有自己的延音线写法（ABC、Muse）
pub fn has_tie_syntax(doc: &ScoreDoc) -> bool {
    matches!(doc.source_format, SourceFormat::Abc | SourceFormat::Jcx)
}

#[derive(Clone, Debug, Default)]
pub struct ProjectOptions {
    /// 换行改照这些音起行（简谱视图实际排出的各行首音）。None = 用模型里的换行
    pub line_starts: Option<HashSet<ElementId>>,
    /// `line_starts` 落在小节中间的也原位断
    pub mid_line_starts: bool,
    /// 相邻两个同音的弧当延音线（简谱口径）。None = 缺省（是）
    pub slur_ties: Option<bool>,
}

/// `Song` → MusicXML 形状的 `Song`（MusicXML 形状的原样借出）
pub fn project_for_music_xml<'a>(src: &'a Song, _options: &ProjectOptions) -> Result<Cow<'a, Song>, Msg> {
    if is_xml_shaped(src) {
        return Ok(Cow::Borrowed(src));
    }
    Err(Msg::new("engine.unimplemented"))
}
