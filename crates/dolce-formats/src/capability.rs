//! **格式能力表**：每种目标格式装得下什么（同 `src/convert/capability.ts`）。
//!
//! 另存为别的格式之前，算出「这份文档里用到、但目标格式装不下」的东西列给用户（`editor/dialogs.ts::showConfirmDialog`）。
//! 名字与排序（按界面语言）留在 TS 门面 `convert/capability.ts`。
//!
//! 表里的内容不是凭空写的，每一条都来自既有的实测与各模块文档的「已知限制」：
//!
//! | 来源 | 得到的条目 |
//! |---|---|
//! | dev `docs/待办/格式与版面.md`「无法表达」的全语料实测 | 文字行 `W:` / 圆滑线 / 多段歌词 / 印刷段号 / 多声部 / 分曲 / 倚音 / 房号 |
//! | `docs/模块/模型-scoredoc.md` | `playOrder`（`.Repeat`）只有 `.jpwabc` 装得下（`<ending>` 只能整小节），`style` MusicXML 装不下 |
//! | `docs/模块/源格式-abc家族.md` | ABC 那一档的 clef/修饰、`Q:` 参照音符长度 |
//! | `break-roundtrip-check`（断点写回 → 各写出端 → 读回） | 换页（ABC 装不下）；换行含小节中间的，六种都装得下，不列 |
//!
//! **改这张表之前先去改那几处的实测**——这里只是它们的汇总。

use crate::fanqie::plan::{fanqie_arc_losses, short_open_voltas};
use dolce_model::beatgroup::{beat_group_index, beat_group_size};
use dolce_model::deconames::{chord_notehead, deco_key, notehead_of, rehearsal_of, tremolo_strokes};
use dolce_model::emitutil::{arcs_to_next_note, beam_level1, nest_arcs_in_tuplets};
use dolce_model::helpers::{each_chord, inline_break_of, verse_count};
use dolce_model::jianpu::melody_lane;
use dolce_model::jianpuproject::project_for_jianpu;
use dolce_model::pagemeta::{song_header_fonts, song_lyric_size, song_page, song_staff_size};
use dolce_model::staves::has_cross_staff;
use dolce_model::xmlsurface::Surface;
use dolce_model::{BeamVal, BreakKind, Element, Key, Mark, MarkType, ScoreDoc, Song, Spacer, Time};

macro_rules! features {
    ($($v:ident = $s:literal),* $(,)?) => {
        /// 一项「文档里可能用到、格式可能装不下」的特性（名字同 TS `Feature`）
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum Feature { $($v),* }
        impl Feature {
            pub const ALL: &'static [Feature] = &[$(Feature::$v),*];
            pub fn as_str(self) -> &'static str {
                match self { $(Feature::$v => $s),* }
            }
        }
    };
}

features! {
    Harmony = "harmony", HarmonyOffset = "harmonyOffset", MultiVoice = "multiVoice", NoteStack = "noteStack",
    InnerVoice = "innerVoice", InnerVoiceLyrics = "innerVoiceLyrics", ExtraStaff = "extraStaff", CrossStaff = "crossStaff",
    OctaveShift = "octaveShift", BeamGroup = "beamGroup", RhythmStack = "rhythmStack", RhythmPosition = "rhythmPosition",
    GraceArc = "graceArc", Dynamics = "dynamics", PlayOrder = "playOrder", SingOrder = "singOrder", SectionOrder = "sectionOrder",
    Style = "style", LayoutDirectives = "layoutDirectives", KeyChange = "keyChange", TonicDegree = "tonicDegree",
    MultiVerse = "multiVerse", Volta = "volta", ShortOpenVolta = "shortOpenVolta", Grace = "grace", Slur = "slur",
    TextLine = "textLine", MultiSong = "multiSong", PageText = "pageText", Meta = "meta", Paper = "paper",
    VerseLabel = "verseLabel", RhythmNote = "rhythmNote", InvisibleRest = "invisibleRest", NestedArc = "nestedArc",
    OddTuplet = "oddTuplet", SlurCrossTuplet = "slurCrossTuplet", LyricOnRest = "lyricOnRest", PageBreak = "pageBreak",
    Tremolo = "tremolo", Bowing = "bowing", Rehearsal = "rehearsal", MultiRest = "multiRest", Notehead = "notehead",
    Arpeggio = "arpeggio", Staccatissimo = "staccatissimo",
}

/// 目标格式（文本谱两种方言各算一种）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetFormat {
    J123,
    Abc,
    Jpwabc,
    Tomato,
    Shige,
    Jly,
    Jcx,
    MusicXml,
}

impl TargetFormat {
    pub fn parse(s: &str) -> Option<TargetFormat> {
        Some(match s {
            "123" => TargetFormat::J123,
            "abc" => TargetFormat::Abc,
            "jpwabc" => TargetFormat::Jpwabc,
            "tomato" => TargetFormat::Tomato,
            "shige" => TargetFormat::Shige,
            "jly" => TargetFormat::Jly,
            "jcx" => TargetFormat::Jcx,
            "musicxml" => TargetFormat::MusicXml,
            _ => return None,
        })
    }
}

use Feature as F;

/// 文本谱两种方言都装不下的。依据见 `fanqie/tofanqie.ts` 开头与 `docs/模块/源格式-文本谱.md` 的已知限制：
/// 样式表引用、演唱顺序、扩展 meta 没有字段可落（文本谱只有按位置的 XL/XR/TL/TR/BL/BC/BR，不往里猜）；
/// 音符堆（和音）只写简谱印的那个音（同谱表的第二声部写 `{dsb…}` 并排块，写得出）；弧线与多连音共用一个先开先闭的括号队列。
const FANQIE_GONE: &[Feature] = &[
    // `{dsb…}` 并排块里不跟词
    F::InnerVoiceLyrics,
    F::BeamGroup, F::OctaveShift, F::Style, F::PlayOrder, F::SingOrder, F::SectionOrder, F::HarmonyOffset,
    F::Meta, F::Paper, F::NoteStack, F::ExtraStaff, F::RhythmStack, F::RhythmPosition, F::GraceArc, F::NestedArc, F::OddTuplet,
    // 文本谱的记号表里没有这几样（番茄脚本规范同；用户定 2026-10-21 不扩，要的走 123）
    F::Tremolo, F::Bowing, F::Rehearsal, F::MultiRest, F::Arpeggio, F::Notehead,
    // 顿音只有一个 `dy`：楔形与点状并成一个，读回来都是点状
    F::Staccatissimo,
];
/// 只有 123 与 MusicXML 装得下的（123 的扩展写法，规范 §8.3 / §9）
const EXT_123: &[Feature] = &[F::Tremolo, F::Bowing, F::Rehearsal, F::MultiRest, F::Arpeggio, F::Notehead];

/// 目标格式装不下的特性（能力表「除了这几样，其余都装得下」）。**装不下的写在这里，并在注释里写清依据。**
pub fn gone(target: TargetFormat) -> Vec<Feature> {
    let list: &[&[Feature]] = match target {
        // 123 是按「装得下全部」设计的（`docs/格式/123格式.md`），实测全语料只有 0.17% 表达不了，那些是转换层的账不是格式的账。
        // 嵌套弧与任意比例的多连音（`(5:4:`）都写得出；弧与多连音的括号只许嵌套（从组里连到组外下一个音写 `~`，
        // 跨得更远的写不出）、可见休止不跟词（规范 §4.1、§5.1）
        // 和音写 `[13]`（§4.2，照 ABC 的 `[CEG]`；民乐分谱的双音，用户定 2026-10-21 加）；同一谱表上的第二 voice 照 ABC §7.4 写 `&`、
        // 节奏音符的谱表位置与同时敲的几个写 `X@E5` / `[X@E5X@F5]`（§4.2、§4.3，用户定 2026-10-21 加）；
        // 一个声部的几条谱表各写一个 `V:`、第二条起 `part=`（§7，`staves.rs`，用户定 2026-10-24），跨谱表的东西写不出
        // 八度线（8va）两种格式都没有写法（abc2svg 的 `!8va(!` 是扩展，用户定不扩），音照实际音高写
        // 符杠一律按拍自动连（§11「语料高频但刻意不做」），写明的跨拍连杠写不出
        // `w:` 只跟 `&` 的第一支（§7.4），第二支自己的歌词写不出
        // `.Repeat` 的演唱顺序写不出（`I:playorder` 用户定 2026-10-31 去掉）；分段跳着唱写 `P:`，投影逐页逐行定死写 `%%sing`（用户定 2026-11-03）
        TargetFormat::J123 => &[&[F::PlayOrder, F::HarmonyOffset, F::CrossStaff, F::InnerVoiceLyrics, F::SlurCrossTuplet, F::LyricOnRest, F::OctaveShift, F::BeamGroup]],
        // 标准 ABC：样式被规范标为 VOLATILE（§11，「not standardised」），所以 123 才把样式另走样式表；`.Repeat` 的演唱顺序同 123 写不出。
        // 休止不跟词（ABC §5.1「syllables are not aligned on … rests」）；
        // 换页写 `%%newpage`（§11.4.7 排版指令）；换行本身含小节中间的都装得下（`break-roundtrip-check` 实测）
        // 弓法、震音是 ABC 的标准装饰（写得出）；排练号、`Zn` 多小节休止写出端只给 123
        // 大谱表同 123：每条谱表一个 `V:`、第二条起 `part=`，跨谱表的东西写不出
        TargetFormat::Abc => &[&[
            F::Style, F::PlayOrder, F::SingOrder, F::InnerVoiceLyrics, F::RhythmNote, F::RhythmStack, F::RhythmPosition, F::CrossStaff,
            F::OctaveShift, F::HarmonyOffset, F::LyricOnRest, F::Rehearsal, F::MultiRest,
        ]],
        // `.jpwabc` 的语法**刻意不扩**：和弦、力度、多声部都写不进去。音符堆：写出端只留最高音、删 voice > 1。
        // `P:` 不展开进 `.Repeat`（用户定 2026-10-31：`.Repeat` 是旧私有扩展，只读不写新东西）
        TargetFormat::Jpwabc => &[
            &[
                F::SectionOrder, F::SingOrder, F::BeamGroup, F::OctaveShift, F::TonicDegree, F::Harmony, F::HarmonyOffset, F::Slur, F::Dynamics,
                F::MultiVoice, F::NoteStack, F::InnerVoice, F::ExtraStaff, F::RhythmStack, F::RhythmPosition, F::Style, F::LayoutDirectives,
                F::MultiSong, F::Grace, F::Meta, F::Paper, F::NestedArc, F::OddTuplet,
            ],
            EXT_123,
        ],
        // 文本谱：投影档谱面不画和弦 / 力度 / 多声部，但文本谱**原文**装得下和弦、力度（`&f`、`<`…`!`）——
        // 这里算的是「另存为之后还在不在」，所以按解析器的能力写。
        // 番茄另外没有页眉页脚与版面指令字段（写了会被嗅探成诗歌本，见 `fanqie/dialect.ts::EmitStyle.pageFields`）；
        // 番茄的调号字段 `D:` 只有音名、没有主音唱名（诗歌本的 `6=E4/4` 写得出）；
        // 只罩一小节的房 `]/` 不生效、照样封口（番茄官方，`fanqie/dialect.ts::openVoltaNeedsTwoMeasures`）
        TargetFormat::Tomato => &[FANQIE_GONE, &[F::PageText, F::LayoutDirectives, F::TonicDegree, F::ShortOpenVolta]],
        TargetFormat::Shige => &[FANQIE_GONE],
        // jianpu-ly 装不下什么，依据 `docs/格式/jianpu-ly.md` 与 `tojly.ts` 的 `warnings`：
        //   · 多声部 / 多曲只写第一路（`NextScore` 本版不写）；扩展 meta、纸、样式表、页面文字没有字段；
        //   · 演唱顺序只认跳转裸词（`Fine`/`DC`/`Segno`/`ToCoda`），`playOrder` 的自定义跳转写不出；
        //   · 演奏法（`articulations` 里不是力度名的那批）、拉丁歌词的连字符（`syllabic`）写不出；
        //   · 房号只能两房（第 3 房起退化）；换页能写 `\pageBreak`，但**再读回来**会降级成换行；
        //   · 版面指令只认它自己那几个开关（`NoBarNums` 等），文本谱那套 `fontsize`/`margin` 写不出。
        TargetFormat::Jly => &[
            &[
                F::BeamGroup, F::OctaveShift, F::RhythmStack, F::RhythmPosition, F::InnerVoice, F::ExtraStaff, F::MultiVoice, F::MultiSong, F::Meta,
                F::Paper, F::Style, F::PageText, F::PlayOrder, F::SingOrder, F::SectionOrder, F::LayoutDirectives, F::Dynamics, F::VerseLabel,
                F::TonicDegree,
            ],
            EXT_123,
        ],
        // Muse `.jcx`（`emit.rs`，说明书 §3.2）：一个文件一首；没有样式表、演唱顺序、扩展 meta（只留「来源」`S:`）、
        // 纸张字段（Muse 的 `%%` 排版参数与本项目的不是一套）；页面文字只有左上 `I:` 与右上 `C:`，页脚没有；
        // 力度没有对应的装饰名（渐强渐弱的 `(<` `<)` 写得出）；歌词没有印刷段号、休止不跟词（同 ABC）；换页退成换行
        TargetFormat::Jcx => &[
            &[
                F::BeamGroup, F::OctaveShift, F::RhythmStack, F::RhythmPosition, F::InnerVoice, F::ExtraStaff, F::MultiSong, F::Style, F::PlayOrder,
                F::SingOrder, F::SectionOrder, F::Meta, F::Paper, F::PageText, F::LayoutDirectives, F::Dynamics, F::VerseLabel, F::LyricOnRest,
                F::HarmonyOffset, F::PageBreak, F::TonicDegree,
            ],
            EXT_123,
        ],
        // MusicXML 装不下的两样：`playOrder` 的 skip/limit（`<ending>` 只能整小节）与样式引用。
        // 见 `docs/模块/模型-scoredoc.md` 的关键判据。主音唱名（`6=E`）只有 `<fifths>`/`<mode>`，读回不记唱名。
        // jianpu-ly、Muse、`.jpwabc` 的调号也只写 `1=` 大调 / 调号，主音唱名同样写不出。
        TargetFormat::MusicXml => &[&[F::PlayOrder, F::SingOrder, F::SectionOrder, F::Style, F::LayoutDirectives, F::NestedArc, F::OddTuplet, F::TonicDegree]],
    };
    list.iter().flat_map(|l| l.iter().copied()).collect()
}

/// 目标格式装不装得下这项
pub fn can_hold(target: TargetFormat, f: Feature) -> bool {
    !gone(target).contains(&f)
}

/// 文本谱认的版面指令（`/^(fontsize|margin|space|off)$/i`）
fn is_layout_directive(key: &str) -> bool {
    ["fontsize", "margin", "space", "off"].iter().any(|k| key.eq_ignore_ascii_case(k))
}

fn key_differs(a: &Key, b: &Key) -> bool {
    a.fifths != b.fifths
        || a.spelling.as_deref().unwrap_or("") != b.spelling.as_deref().unwrap_or("")
        || a.tonic_degree.as_deref().unwrap_or("1") != b.tonic_degree.as_deref().unwrap_or("1")
}

/// JS 真值：数字非 0 非 NaN
fn truthy(v: Option<f64>) -> bool {
    v.is_some_and(|x| x != 0.0 && !x.is_nan())
}

/// 写明的符杠分组与按拍自动连的不一样（跨拍连成一组、或一拍里断开）。只看第一层
fn irregular_beams(song: &Song) -> bool {
    for part in &song.parts {
        let mut divisions = 1.0;
        let mut time = Time { beats: 4.0, beat_type: 4.0, symbol: None, parenthesized: None };
        for m in &part.measures {
            if let Some(a) = &m.attrs {
                if truthy(a.divisions) {
                    divisions = a.divisions.unwrap();
                }
                if let Some(t) = &a.time {
                    time = t.clone();
                }
            }
            let size = beat_group_size(time.beats, time.beat_type);
            let mut end = 0.0;
            // 各声部：上一个连杠音的拍号（组号 TS 记了但不比）
            let mut prev: Vec<(f64, f64)> = vec![];
            for el in &m.elements {
                let (onset, dur) = match el {
                    Element::Chord(c) => (c.onset, if c.grace.is_some() { 0.0 } else { c.duration.divisions }),
                    Element::Space(s) => (s.onset, s.duration.as_ref().map_or(0.0, |d| d.divisions)),
                };
                let s = onset.unwrap_or(end);
                end = s + dur;
                let Element::Chord(c) = el else { continue };
                if c.grace.is_some() {
                    continue;
                }
                let at = prev.iter().position(|p| p.0 == c.voice);
                let Some(b) = beam_level1(c.beams.as_ref()) else {
                    if let Some(i) = at {
                        prev.remove(i);
                    }
                    continue;
                };
                let beat = beat_group_index(s / divisions, 0.0, size);
                if let Some(i) = at {
                    let pb = prev[i].1;
                    if b != BeamVal::Begin && pb != beat {
                        return true;
                    }
                    if b == BeamVal::Begin && pb == beat {
                        return true;
                    }
                    prev[i].1 = beat;
                } else {
                    prev.push((c.voice, beat));
                }
            }
        }
    }
    false
}

/// 这份文档实际用到了哪些特性（`surface`：MusicXML 读进来的表层，页眉字体要查它；文本来源给 None）
pub fn features_used(doc: &ScoreDoc, surface: Option<&Surface>) -> Vec<Feature> {
    let mut used: Vec<Feature> = vec![];
    let mut add = |f: Feature| {
        if !used.contains(&f) {
            used.push(f);
        }
    };
    if doc.songs.len() > 1 {
        add(F::MultiSong);
    }
    for song in &doc.songs {
        if song.parts.len() > 1 {
            add(F::MultiVoice);
        }
        if song.play_order.as_ref().is_some_and(|v| !v.is_empty()) {
            add(F::PlayOrder);
        }
        if song.sing_order.as_ref().is_some_and(|v| !v.is_empty()) {
            add(F::SingOrder);
        }
        if song.section_order.is_some() {
            add(F::SectionOrder);
        }
        if let Some(st) = &song.style {
            if st.sheet_ref.as_deref().is_some_and(|s| !s.is_empty()) || st.inline.as_ref().is_some_and(|v| !v.is_empty()) {
                add(F::Style);
            }
            for r in st.raw.iter().flatten() {
                add(if is_layout_directive(&r.key) { F::LayoutDirectives } else { F::Style });
            }
        }
        let projected = project_for_jianpu(song);
        if song.page_text.is_some() || projected.page_text.is_some() {
            add(F::PageText);
        }
        if song.meta.as_ref().is_some_and(|m| !m.is_empty()) {
            add(F::Meta);
        }
        if song_page(song).is_some() || truthy(song_staff_size(song)) || truthy(song_lyric_size(song)) || !song_header_fonts(song, surface).is_empty() {
            add(F::Paper);
        }
        if song.remarks.as_ref().is_some_and(|v| !v.is_empty()) {
            add(F::TextLine);
        }
        if verse_count(song) > 1.0 {
            add(F::MultiVerse);
        }
        if song.key.as_ref().and_then(|k| k.tonic_degree.as_deref()).is_some_and(|t| !t.is_empty() && t != "1") {
            add(F::TonicDegree);
        }
        for m in &song.marks {
            if m.kind == MarkType::Slur {
                add(F::Slur);
            }
            if m.kind == MarkType::Wedge {
                add(F::Dynamics);
            }
        }
        for part in &song.parts {
            for (mi, mea) in part.measures.iter().enumerate() {
                if mi > 0 {
                    if let (Some(k), Some(sk)) = (mea.attrs.as_ref().and_then(|a| a.key.as_ref()), song.key.as_ref()) {
                        if key_differs(k, sk) {
                            add(F::KeyChange);
                        }
                    }
                    if mea.print.as_ref().is_some_and(|p| p.new_page == Some(true)) {
                        add(F::PageBreak);
                    }
                }
                if mea.elements.iter().any(|el| inline_break_of(el) == Some(BreakKind::Page)) {
                    add(F::PageBreak);
                }
            }
            for mea in &part.measures {
                let lane = melody_lane(mea);
                if mea.barlines.iter().flatten().any(|b| b.ending.is_some()) {
                    add(F::Volta);
                }
                for d in mea.directions.iter().flatten() {
                    if d.kind == "dynamics" || d.kind == "wedge" {
                        add(F::Dynamics);
                    }
                    if d.kind == "rehearsal" || d.more.iter().flatten().any(|x| x.kind == "rehearsal") {
                        add(F::Rehearsal);
                    }
                    if d.kind == "octave-shift" {
                        add(F::OctaveShift);
                    }
                }
                if mea.attrs.as_ref().is_some_and(|a| truthy(a.multi_rest)) {
                    add(F::MultiRest);
                }
                for el in &mea.elements {
                    let c = match el {
                        Element::Space(s) => {
                            if s.spacer == Spacer::X {
                                add(F::InvisibleRest);
                            }
                            if s.harmony.is_some() {
                                add(F::Harmony);
                            }
                            continue;
                        }
                        Element::Chord(c) => c,
                    };
                    if c.harmony.is_some() {
                        add(F::Harmony);
                    }
                    let n = c.notations.as_ref();
                    let arts: &[String] = n.and_then(|n| n.articulations.as_deref()).unwrap_or(&[]);
                    if n.is_some_and(|n| truthy(n.tremolo)) || arts.iter().any(|a| tremolo_strokes(a).is_some()) {
                        add(F::Tremolo);
                    }
                    if n.and_then(|n| n.technical.as_ref()).is_some_and(|t| t.iter().any(|x| x == "up-bow" || x == "down-bow"))
                        || arts.iter().any(|a| matches!(deco_key(a), Some("sg") | Some("xg")))
                    {
                        add(F::Bowing);
                    }
                    if arts.iter().any(|a| rehearsal_of(a).is_some()) {
                        add(F::Rehearsal);
                    }
                    if arts.iter().any(|a| a == "staccatissimo" || a == "wedge") {
                        add(F::Staccatissimo);
                    }
                    if n.is_some_and(|n| n.arpeggiate == Some(true)) || arts.iter().any(|a| deco_key(a) == Some("arp")) {
                        add(F::Arpeggio);
                    }
                    let head = chord_notehead(c.notes.iter().map(|x| x.notehead.as_deref()));
                    if head.is_some_and(|h| h != "slash") || arts.iter().any(|a| notehead_of(a).is_some_and(|h| !h.is_empty())) {
                        add(F::Notehead);
                    }
                    let rhythm = c.rhythm == Some(true);
                    if c.notes.len() > 1 {
                        add(if rhythm { F::RhythmStack } else { F::NoteStack });
                    }
                    if rhythm && c.notes.iter().any(|x| x.unpitched.as_ref().is_some_and(|u| u.step.is_some())) {
                        add(F::RhythmPosition);
                    }
                    if let Some((staff, voice)) = lane {
                        if c.staff != staff {
                            add(F::ExtraStaff);
                        } else if c.voice != voice {
                            add(F::InnerVoice);
                            if c.lyrics.iter().flatten().any(|l| !l.text.is_empty()) {
                                add(F::InnerVoiceLyrics);
                            }
                        }
                    }
                    if c.grace.is_some() {
                        add(F::Grace);
                    }
                    if rhythm {
                        add(F::RhythmNote);
                    }
                    if c.section_word.as_deref().is_some_and(|s| !s.is_empty()) {
                        add(F::TextLine);
                    }
                    if c.print_object == Some(false) && c.rest.is_some() {
                        add(F::InvisibleRest);
                    }
                    if c.rest.is_some() && c.print_object != Some(false) && c.lyrics.iter().flatten().any(|l| !l.text.is_empty()) {
                        add(F::LyricOnRest);
                    }
                    if c.lyrics.iter().flatten().any(|l| l.verse_label.is_some()) {
                        add(F::VerseLabel);
                    }
                }
            }
        }
        if has_cross_staff(song) {
            add(F::CrossStaff);
        }
        if irregular_beams(song) {
            add(F::BeamGroup);
        }
        for (_, _, c) in each_chord(song) {
            if c.sustains.iter().flatten().any(|su| su.harmony.is_some()) {
                add(F::Harmony);
            }
        }
        // 长音中途换和弦：进简谱形状后还挂不到增时线上的才算
        let later = |s: &Song| each_chord(s).any(|(_, _, c)| c.later_harmonies.as_ref().is_some_and(|v| !v.is_empty()));
        if later(song) && later(&projected) {
            add(F::HarmonyOffset);
        }
        // 跨出多连音的弧：连到下一个音的写成 `~`，不算；判据与写出端同一份
        let is_arc = |m: &Mark| m.kind == MarkType::Slur || m.kind == MarkType::Tied;
        for part in &song.parts {
            let nest = nest_arcs_in_tuplets(part, &song.marks, is_arc);
            if nest.crossed_marks.len() > arcs_to_next_note(part, &song.marks, is_arc, None).len() {
                add(F::SlurCrossTuplet);
            }
        }
        if song.parts.iter().any(|p| !short_open_voltas(p).is_empty()) {
            add(F::ShortOpenVolta);
        }
        let arcs = fanqie_arc_losses(song);
        if arcs.nested > 0 {
            add(F::NestedArc);
        }
        if arcs.odd_tuplet > 0 {
            add(F::OddTuplet);
        }
        if arcs.grace_arc > 0 {
            add(F::GraceArc);
        }
    }
    used
}

/// 存成 `target` 会丢掉什么 = 用到的 ∖ 目标装得下的（按发现的先后；TS 门面按名字排）
pub fn plan_save(doc: &ScoreDoc, target: TargetFormat, surface: Option<&Surface>) -> Vec<Feature> {
    let gone = gone(target);
    features_used(doc, surface).into_iter().filter(|f| gone.contains(f)).collect()
}
