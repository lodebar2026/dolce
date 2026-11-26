//! 样式表对外的名字 → 各把尺子的内部字段（照 `style/keys.ts`）。
//!
//! `.ss` 里只见**逻辑键**（kebab-case，按谱面内容分）：`@jianpu` = 简谱内容（纯简谱落 `JianpuStyle`，混排落 `MixedOptions` 的简谱层字段），
//! `@staff` = 五线谱内容（落 `MixedOptions`）。表里缺一边 = 那个模式不支持这个键，解析期就报错（`ss.rs`）。

/// 值的种类：长度（收 em/sp/裸数）、纯数（比例、层数）、开关、词（枚举值）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind {
    Len,
    Num,
    Bool,
    Word,
}

#[derive(Clone, Copy, Debug)]
pub struct KeyDef {
    pub kind: KeyKind,
    /// `JianpuStyle` 上的路径（`stroke.beam`…）；缺 = 纯简谱那几档不支持。
    pub jianpu: Option<&'static str>,
    /// `MixedOptions` 上的字段名（可带一级子路径，如 `lineWidths.stem`）；缺 = 混排/五线谱不支持。
    pub mixed: Option<&'static str>,
    /// 成书 `BookStyle` 上的路径（`metrics.systemGapEm`…）；字段名以 `Em` 结尾的样式表里必须写 em。
    pub book: Option<&'static str>,
    /// 解析出的长度再乘这个数才落进 `jianpu` 那一列。
    pub jianpu_scale: Option<f64>,
    /// 不支持的那一侧的说法，进报错信息。
    pub note: Option<&'static str>,
}

const fn def(kind: KeyKind) -> KeyDef {
    KeyDef { kind, jianpu: None, mixed: None, book: None, jianpu_scale: None, note: None }
}

impl KeyDef {
    const fn j(mut self, p: &'static str) -> Self {
        self.jianpu = Some(p);
        self
    }
    const fn m(mut self, p: &'static str) -> Self {
        self.mixed = Some(p);
        self
    }
    const fn b(mut self, p: &'static str) -> Self {
        self.book = Some(p);
        self
    }
    const fn s(mut self, k: f64) -> Self {
        self.jianpu_scale = Some(k);
        self
    }
    const fn n(mut self, t: &'static str) -> Self {
        self.note = Some(t);
        self
    }
}

use KeyKind::*;

/// 角色 → 两把尺子上的字体字段（`ROLE_FONTS`）。`chord` 在混排是族名串（`wordFont`）。
pub struct RoleFont {
    pub role: &'static str,
    pub jianpu: Option<&'static str>,
    pub mixed: Option<&'static str>,
    pub mixed_family_only: bool,
}

pub const ROLE_FONTS: [RoleFont; 4] = [
    RoleFont { role: "note", jianpu: Some("note"), mixed: Some("jianpuFont"), mixed_family_only: false },
    RoleFont { role: "lyric", jianpu: Some("lyric"), mixed: None, mixed_family_only: false },
    RoleFont { role: "smufl", jianpu: Some("smufl"), mixed: Some("musicFont"), mixed_family_only: false },
    RoleFont { role: "chord", jianpu: None, mixed: Some("wordFont"), mixed_family_only: true },
];

/// `@jianpu`：简谱内容。
pub const JIANPU_KEYS: &[(&str, KeyDef)] = &[
    ("note-bold", def(Bool).j("look.noteBold").n("混排的简谱数字不单独加粗")),
    ("pair-pages", def(Bool).j("look.pairPages").n("只投影档读：多段两两并页，默认不并")),
    ("no-intro", def(Bool).j("look.noIntro").n("只投影档读：不排第一个字之前的前奏，默认照排")),
    ("even-justify", def(Bool).j("look.evenJustify").n("两端对齐把余量等量加到各个空档（旧投影片的排法），默认水位法灌平")),
    ("beam-width", def(Len).j("stroke.beam").m("lineWidths.jpBeam")),
    ("stack-gap", def(Num).j("vertical.stackGap").m("stackGap").b("metrics.stackGap")),
    ("slur-gap", def(Len).j("vertical.slurGap").b("metrics.stackGapEm").n("弧离叠层顶的空，混排与原样文档各按自己的弧算")),
    ("system-gap", def(Len).j("vertical.systemGap")),
    ("system-spread", def(Len).j("vertical.systemSpread").b("metrics.systemGapEm")),
    ("note-step", def(Len).b("metrics.noteStepEm").n("音符步距只有成书断句用")),
    ("lyric-gap", def(Len).j("spacing.lyricGap").b("metrics.lyricGapEm")),
    ("lyric-baseline", def(Len).j("vertical.lyricBaseline")),
    ("lyric-stack", def(Len).j("vertical.lyricStack").b("metrics.lyricToLyricEm")),
    ("chord-gap", def(Len).j("vertical.chordGap").b("metrics.chordToNoteEm")),
    ("lrc-punct-compress", def(Word).j("look.punctCompress").m("punctCompress")),
    ("chord-plain", def(Bool).j("look.chordPlain").m("chordPlain").b("metrics.chordPlain")),
    ("accidental-side", def(Word).j("look.accidentalSide").m("accidentalSide").b("metrics.accidentalSide")),
    ("accidental-style", def(Word).j("look.accidentalStyle").m("accidentalStyle").b("metrics.accidentalStyle")),
    ("accidental-scale", def(Num).j("look.accidentalScale").m("accidentalScale").n("成书照原书用 classic，不读这个")),
    ("bracket-width", def(Len).j("stroke.bracket").b("metrics.bracketWidth")),
    ("bracket-foot", def(Len).j("vertical.bracketFoot").b("metrics.bracketFootEm")),
    ("tuplet-style", def(Word).j("look.tupletStyle").n("取 bracket（括线）/ arc（两段弧）；成书与混排不支持")),
    ("repeat-dot-diameter", def(Len).j("dot.repeat").s(0.5).b("metrics.repeatDotDiam")),
    ("dot-radius", def(Len).j("dot.octave")),
    ("aug-dot-radius", def(Len).j("dot.aug")),
    ("slur-thickness", def(Len).j("stroke.slur").b("metrics.slurThicknessEm")),
    ("slur-outline", def(Len).j("stroke.slurOutline")),
    ("slur-arc", def(Len).b("metrics.slurArcEm").n("弧高目标只有成书反算缩放用")),
    ("slur-max-arc", def(Len).j("arc.maxHeight").s(1.0 / 0.75).b("metrics.slurMaxArcEm")),
    ("slur-min-arc", def(Len).j("arc.minHeight").s(1.0 / 0.75).b("metrics.slurMinArcEm")),
    ("slur-flat-span", def(Num).b("metrics.slurFlatSpanSteps").n("纯简谱的扁平阈值是物理宽度（slurFlatSpan）")),
    ("slur-flat-notes", def(Num).j("arc.flatNotes").b("metrics.slurFlatNotes")),
    ("slur-flat-ratio", def(Num).j("arc.flatRatio").b("metrics.slurFlatRatio")),
    ("barline", def(Len).j("stroke.barline").b("metrics.barlineWidthEm")),
    ("final-barline", def(Len).j("stroke.finalBarline").b("metrics.finalBarlineWidthEm")),
    ("hairpin-width", def(Len).j("stroke.hairpin")),
    ("time-sig-rule", def(Len).j("stroke.timeSigRule")),
    ("verse-numbers", def(Word).j("look.verseNumbers").m("verseNumbers").b("layout.verseNumbers")),
    ("max-horizontal-scale", def(Num).j("spacing.maxHorizontalScale").b("layout.maxHorizontalScale")),
    ("grace-scale", def(Num).j("size.grace").m("jpGraceScale")),
    ("show-key-change", def(Bool).m("showKeyChangeJp").n("纯简谱一定画调号")),
    ("key-uses-full-font", def(Bool).m("jpKeyJianpuFont").n("纯简谱没有缩小的简谱层")),
    ("legacy-time-sig", def(Bool).m("musicppJpTimeSig").n("旧版拍号笔位只在混排有")),
    ("legacy-hwid-glyphs", def(Bool).m("musicppHwidGlyphs").n("同上")),
    ("chinese-hyphen", def(Bool).m("chineseHyphen").n("纯简谱不画中文连字符")),
    ("voice-gap", def(Len).j("vertical.voiceGap")),
    ("barline-height", def(Len).j("vertical.barlineHeight")),
    ("double-barline-gap", def(Len).j("stroke.doubleBarlineGap")),
];

/// `@staff`：五线谱内容。
pub const STAFF_KEYS: &[(&str, KeyDef)] = &[
    ("staff-height", def(Len).m("mixStaffHeight")),
    ("staff-dist", def(Len).m("mixStaffDist")),
    ("barline-dist", def(Len).m("barlineDist")),
    ("slur-stem-dy", def(Len).m("slurStemDy")),
    ("harmony-size", def(Len).m("harmonySize")),
    ("harmony-y-pos", def(Len).m("harmonyYPos")),
    ("cue-size", def(Num).m("cueSize")),
    ("hide-bar-number", def(Bool).m("hideBarNumber")),
    ("initial-key-time", def(Bool).m("initialKeyTime")),
    ("melody-only", def(Bool).m("melodyOnly")),
    ("text-line-height-by-size", def(Bool).m("textLineHeightBySize")),
    ("staff-line", def(Len).m("lineWidths.staff")),
    ("leger", def(Len).m("lineWidths.leger")),
    ("stem", def(Len).m("lineWidths.stem")),
    ("beam", def(Len).m("lineWidths.beam")),
    ("barline", def(Len).m("lineWidths.lightBarline")),
    ("final-barline", def(Len).m("lineWidths.heavyBarline")),
];

/// `@break`：断句。**与谱式无关**——现在只有成书读。
pub const BREAK_KEYS: &[(&str, KeyDef)] = &[
    ("enable", def(Bool).b("layout.phrase")),
    ("lines-per-page", def(Num).b("layout.linesPerPage")),
    ("target-measures", def(Num).b("layout.phraseTargetMeas")),
    ("length-weight", def(Num).b("layout.phraseLenWeight")),
    ("break-weight", def(Num).b("layout.phraseBreakWeight")),
    ("mid-break", def(Bool).b("layout.phraseMidBreak")),
    ("merge-short", def(Bool).b("layout.phraseMergeShort")),
    ("even-weight", def(Num).b("layout.phraseEvenWeight")),
    ("tail-weight", def(Num).b("layout.phraseTailWeight")),
    ("content-only", def(Bool).b("layout.phraseContentOnly")),
    ("parallel-weight", def(Num).b("layout.phraseParallelWeight")),
    ("tail-long-weight", def(Num).b("layout.phraseTailLongWeight")),
    ("more-rows-slack", def(Num).b("layout.phraseMoreRowsSlack")),
    ("fit-slack", def(Num).b("layout.phraseFitSlack")),
];

/// 块名 → 键表（`keysOfBlock`）。
pub fn keys_of_block(block: &str) -> &'static [(&'static str, KeyDef)] {
    match block {
        "jianpu" => JIANPU_KEYS,
        "staff" => STAFF_KEYS,
        _ => BREAK_KEYS,
    }
}

/// 表里查一个键。
pub fn lookup(table: &'static [(&'static str, KeyDef)], key: &str) -> Option<&'static KeyDef> {
    table.iter().find(|(k, _)| *k == key).map(|(_, d)| d)
}

/// `@flow` 的键（`song-start` 归混排歌本，其余 → `BookStyle.titleBlock`）。
pub const FLOW_KEYS: &[(&str, Option<&str>)] = &[
    ("song-start", None),
    ("number-baseline", Some("numberBaseline")),
    ("first-system-top", Some("firstSystemTop")),
    ("cont-system-top", Some("contSystemTop")),
    ("mid-start-gap", Some("midStartGap")),
    ("footer-baseline", Some("footerBaseline")),
];

/// `@toc`：成书目录与索引页的几何（→ `BookStyle.toc`）。
pub const TOC_KEYS: &[(&str, &str)] = &[
    ("title-baseline", "titleBaseline"),
    ("heading-gap-above", "headingGapAbove"),
    ("heading-gap-below", "headingGapBelow"),
    ("leader", "leader"),
    ("entry-line-height", "lineGap"),
    ("entry-first-baseline", "firstBaseline"),
    ("left-edge", "left"),
    ("right-edge", "right"),
    ("index-columns", "indexColumns"),
    ("index-line-height", "indexLineGap"),
    ("index-first-baseline", "indexFirstBaseline"),
];
