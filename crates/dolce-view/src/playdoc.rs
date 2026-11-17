//! `ScoreDoc`（MusicXML 形状）→ 演唱顺序、试听输入（同原 `model/playdoc.ts`）。`.jpwabc` 写出端的输入在 `dolce-formats::jpw::input`。
//!
//! 口径（回归 `playorder-check`）：
//!   - 反复与跳转只读第一声部；小节、和弦、歌词段号、房号、反复经 [`crate::phrasedoc`] 拼（与断句同一份输入）
//!   - 跳转取 `<direction><sound>`：落点是**游标当时的位置**（最后一个非倚音和弦的终点），
//!     由 `Direction.afterElements` 还原成它前面那个音符的终点
//!
//! 简谱形状（文本谱 / 123 / ABC / `.jpwabc`）在 [`crate::playsong`]。

use std::collections::HashMap;

use dolce_base::{js, Fraction};
use dolce_model::helpers::distinct_numbers;
use dolce_model::jianpu::midi_pitch;
use dolce_model::keyshift::{is_minor_key, key_fifths, sounding_fifths};
use dolce_model::sections::anchor_play_order;
use dolce_model::{Chord, Direction, Element, ElementId, Key, Measure, Part, Song};
use dolce_play::playorder::{play_order_from_spec, play_order_of, section_play_order, sing_play_order, PlayItem, PlaySpecKind, RepeatSpecItem, SectionMark, TimePosition};
use dolce_play::timeline::{PlaySource, TimeSig, TimelineChord, TimelineKey, TimelineLyric, TimelineMeasure, TimelineNote, TimelinePart, DEFAULT_VELOCITY};

use crate::phrasedoc::{divisions_of, main_voice_of, onsets, phrase_measures_of_doc, slurs_of, Slurs};
use crate::phrasesong::{fail, MeasureOut, ViewResult};
use crate::playdata::{jump, locate_section_marks, map_set, play_part_of, sing_specs, timeline_measure_of, PlayData};

/// 主旋律声部：第一个带歌词的声部，都没词取第一声部（同简谱形状 `for_expanded` 的口径）。
/// 歌词段数决定唱几遍，第一声部是伴奏、词在后面声部时按第一声部推就少唱了。
pub fn lead_part_of(song: &Song) -> usize {
    song.parts
        .iter()
        .position(|p| {
            p.measures.iter().any(|m| m.elements.iter().any(|el| matches!(el, Element::Chord(c) if c.lyrics.iter().flatten().any(|l| !l.text.is_empty()))))
        })
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy)]
pub struct DocPlayOptions {
    /// 段数按哪个声部的歌词推、`PlayItem.limit` 数哪个声部的和弦。缺省第一声部——引擎输入与 `.jpwabc` 写出端
    /// 画的、写的都是第一声部，必须同一个；只有试听传主旋律声部（[`lead_part_of`]）
    pub lead: usize,
    /// 同音同号的词顺延（试听那份）
    pub distinct: bool,
    /// 按头部 `P:` 排（逐遍演唱顺序、`.Repeat` 优先）
    pub use_sections: bool,
}

impl Default for DocPlayOptions {
    fn default() -> Self {
        DocPlayOptions { lead: 0, distinct: false, use_sections: true }
    }
}

/// 演唱顺序（`measures` / `isSimpple` / `hasRepeat` 与跳转表；速度不在这里）。反复与跳转记号读第一声部。
/// 连同 `lead` 声部的小节序列（断句视图）一起回。
pub fn play_data_of_doc(song: &Song, o: DocPlayOptions) -> ViewResult<(PlayData, Vec<MeasureOut>)> {
    let mut pd = PlayData::default();
    let Some(part) = song.parts.first() else { return fail("no part") };
    let div = divisions_of(part);
    for (mid, m) in part.measures.iter().enumerate() {
        for d in m.directions.iter().flatten() {
            if d.sound.is_some() {
                let tick = TimePosition::new(mid as f64, cursor_at(m, d).div_int(div))?;
                add_sound(&mut pd, d, tick);
            }
        }
    }
    let view = phrase_measures_of_doc(song, o.lead, o.distinct)?;
    let view_part = play_part_of(&view.iter().map(Some).collect::<Vec<_>>());
    // 逐遍演唱顺序（123 `%%sing`）：逐页逐行写定的，优先于 `.Repeat`、`P:` 与谱面记号
    if song.sing_order.as_ref().is_some_and(|s| !s.is_empty()) {
        let slid = sing_play_order(std::slice::from_ref(&view_part), &section_marks_of_doc(song, o.lead, &view), &sing_specs(song))?;
        if !slid.is_empty() {
            pd.measures = slid;
            pd.from_sing = true;
            pd.from_sections = true;
            return Ok((pd, view));
        }
    }
    if let Some(written) = play_order_of_doc(song, o.lead, &view, &view_part) {
        pd.measures = written;
        return Ok((pd, view));
    }
    let seq: Vec<String> = if o.use_sections { song.section_order.as_ref().map(|s| s.seq.clone()).unwrap_or_default() } else { vec![] };
    let parts = std::slice::from_ref(&view_part);
    let by_sections = if seq.is_empty() { None } else { section_play_order(parts, &pd.jumps(), &seq, &section_marks_of_doc(song, o.lead, &view))? };
    pd.from_sections = by_sections.is_some();
    let order = match by_sections {
        Some(o) => o,
        None => play_order_of(parts, &pd.jumps())?,
    };
    pd.take_order(order);
    Ok((pd, view))
}

/// 元素 id → (声部, 小节, 第几个和弦, 在不在主旋律)。主旋律以外声部的音 `skip` 恒 0、`in_lead` 为假：`skip` 与 `limit` 数的是主旋律的和弦。
fn locator_of_doc(song: &Song, lead: usize, view: &[MeasureOut]) -> HashMap<ElementId, (usize, f64, f64, bool)> {
    let mut where_ = HashMap::new();
    for (rank, p) in song.parts.iter().enumerate() {
        for (mid, m) in p.measures.iter().enumerate() {
            for el in &m.elements {
                where_.insert(el.id(), (rank, mid as f64, 0.0, false));
            }
        }
    }
    for (mid, m) in view.iter().enumerate() {
        for (index, ch) in m.entries.iter().enumerate() {
            if let Some(id) = ch.id {
                where_.insert(id, (lead, mid as f64, index as f64, true));
            }
        }
    }
    where_
}

/// 段落标记 → (小节, 第几个和弦)。写在主旋律以外声部的小节中间时贴到小节头。
fn section_marks_of_doc(song: &Song, lead: usize, view: &[MeasureOut]) -> Vec<SectionMark> {
    let where_ = locator_of_doc(song, lead, view);
    locate_section_marks(song, |id| where_.get(&id).map(|w| (w.0, w.1, w.2)))
}

/// 写明的演唱顺序（`.Repeat`）。投影、读回后小节会拆会并，按首尾和弦找小节；一项的音都找不到就丢掉这一项，
/// 一项都不剩回 None（交回按记号推）。
fn play_order_of_doc(song: &Song, lead: usize, view: &[MeasureOut], view_part: &dolce_play::playorder::PlayPart) -> Option<Vec<PlayItem>> {
    if song.play_order.as_ref().is_none_or(|p| p.is_empty()) {
        return None;
    }
    let where_ = locator_of_doc(song, lead, view);
    let items: Vec<RepeatSpecItem> = anchor_play_order(song)
        .iter()
        .filter_map(|p| {
            let from = where_.get(&p.from_anchor?)?;
            let to = where_.get(&p.to_anchor?)?;
            // 小节被拆开时最后一个音不一定在小节尾，并起来时第一个音不一定在小节头：`skip` / `limit` 照音算
            let count = js::index(to.1).and_then(|i| view.get(i)).map_or(0, |m| m.entries.len()) as f64;
            let limit = if to.3 && to.2 + 1.0 < count { to.2 + 1.0 } else { -1.0 };
            Some(RepeatSpecItem { first: from.1, last: to.1, verse: p.verse.unwrap_or(0.0), skip: from.2, page: p.page_break_after.unwrap_or(false), limit })
        })
        .collect();
    (!items.is_empty()).then(|| play_order_from_spec(&items, Some(view_part)))
}

/// `<direction>` 处的游标（divisions）：它前面最后一个非倚音和弦的终点，各声部各自累计。
pub(crate) fn cursor_at(m: &Measure, d: &Direction) -> Fraction {
    let n = (d.after_elements.unwrap_or(0.0).max(0.0) as usize).min(m.elements.len());
    let at = onsets(m);
    let mut end = 0.0;
    for (i, el) in m.elements[..n].iter().enumerate() {
        if let Element::Chord(c) = el {
            if c.grace.is_none() {
                end = at[i].unwrap() + c.duration.divisions;
            }
        }
    }
    Fraction::int(end)
}

/// 同 `parseSound`（速度除外）。TS 以这次新建的落点对象为键：同一处几个跳转只占一条、取最后设的
fn add_sound(pd: &mut PlayData, d: &Direction, tick: TimePosition) {
    let s = d.sound.as_ref().unwrap();
    if let Some(c) = &s.coda {
        map_set(&mut pd.coda, c, tick);
    }
    if let Some(c) = &s.segno {
        map_set(&mut pd.segno, c, tick);
    }
    let mut spec = None;
    if s.dacapo == Some(true) {
        spec = Some(jump(PlaySpecKind::Dacapo, None));
    }
    if s.fine == Some(true) {
        spec = Some(jump(PlaySpecKind::Fine, None));
    }
    if let Some(v) = &s.dalsegno {
        spec = Some(jump(PlaySpecKind::DalSegno, Some(v)));
    }
    if let Some(v) = &s.tocoda {
        spec = Some(jump(PlaySpecKind::ToCoda, Some(v)));
    }
    if let Some(spec) = spec {
        pd.jump_to.push((tick, spec));
    }
}

/// 谱面速度：第一声部里第一处 `<sound tempo>`（20..400，取整），同 `parseSound`。
pub fn tempo_of_doc(song: &Song) -> f64 {
    for m in song.parts.first().map_or(&[][..], |p| &p.measures[..]) {
        for d in m.directions.iter().flatten() {
            if let Some(t) = d.sound.as_ref().and_then(|s| s.tempo) {
                if (20.0..=400.0).contains(&t) {
                    return js::round(t);
                }
            }
        }
    }
    0.0
}

/// 试听/MIDI 的输入。缺省带全部声部（下标 = `Part` 序）、各 voice、和弦全部音与力度记号；光标只跟主旋律声部（[`lead_part_of`]）的主分支。
/// `melody_only`：只取第一声部的主分支、和弦只取最高音，不带力度——光标跟的旋律档，口径同引擎输入。
pub fn play_source_of_doc(song: &Song, melody_only: bool) -> ViewResult<(PlaySource, PlayData)> {
    let tempo = tempo_of_doc(song);
    if melody_only {
        let (mut pd, view) = play_data_of_doc(song, DocPlayOptions::default())?;
        pd.tempo = tempo;
        let mut next = 0;
        let measures = view.iter().map(|m| Some(timeline_measure_of(m, &mut next))).collect();
        return Ok((PlaySource { parts: vec![TimelinePart { measures, name: None }], play_data: pd.source_order(), lead: None }, pd));
    }
    let lead = lead_part_of(song);
    let (mut pd, _) = play_data_of_doc(song, DocPlayOptions { lead, distinct: true, use_sections: true })?;
    pd.tempo = tempo;
    let slurs = slurs_of(song);
    let mut next = 0;
    let mut parts = vec![];
    for (i, p) in song.parts.iter().enumerate() {
        let lyrics = lyrics_of_part(song, i)?;
        parts.push(timeline_part_of(p, i == lead, &slurs, &lyrics, song.key.as_ref(), &mut next));
    }
    Ok((PlaySource { parts, play_data: pd.source_order(), lead: Some(lead) }, pd))
}

/// 一个声部各和弦的歌词（导出 MIDI 的歌词事件）：段号、副歌取断句输入那份（同音同号已顺延、`findRefrain` 判过副歌，
/// 副歌各遍都唱），字取模型的、并上收尾标点。断句输入只收该声部的主分支，其余 voice 的和弦由 [`chord_entry`] 直接读模型。
fn lyrics_of_part(song: &Song, part_index: usize) -> ViewResult<HashMap<ElementId, Vec<TimelineLyric>>> {
    let mut out = HashMap::new();
    let view = phrase_measures_of_doc(song, part_index, true)?;
    let mut by_id: HashMap<ElementId, &Chord> = HashMap::new();
    for m in &song.parts[part_index].measures {
        for el in &m.elements {
            if let Element::Chord(c) = el {
                by_id.insert(c.id, c);
            }
        }
    }
    for ch in view.iter().flat_map(|m| m.entries.iter()) {
        let Some(id) = ch.id else { continue };
        let Some(el) = by_id.get(&id) else { continue };
        let src = ch.notes.first().map_or(&[][..], |n| &n.lyrics[..]);
        if src.is_empty() {
            continue;
        }
        let model: Vec<_> = el.lyrics.iter().flatten().filter(|l| !l.text.is_empty()).collect();
        let lyrics = src
            .iter()
            .enumerate()
            .map(|(k, l)| TimelineLyric {
                text: format!("{}{}", l.text, model.get(k).and_then(|m| m.trailing_punctuation.as_deref()).unwrap_or("")),
                number: l.number,
                refrain: l.refrain,
                extend: model.get(k).and_then(|m| m.extend).unwrap_or(false),
            })
            .collect();
        out.insert(id, lyrics);
    }
    Ok(out)
}

/// 力度记号 → note-on velocity。表外的（`sf` / `fp` 这类瞬时重音）不改当前力度。
fn velocity_of(text: &str) -> Option<f64> {
    Some(match text {
        "pppp" => 20.0,
        "ppp" => 30.0,
        "pp" => 42.0,
        "p" => 56.0,
        "mp" => 70.0,
        "mf" => 84.0,
        "f" => 98.0,
        "ff" => 112.0,
        "fff" => 122.0,
        "ffff" => 127.0,
        _ => return None,
    })
}

fn timeline_part_of(part: &Part, lead: bool, slurs: &Slurs, lyrics: &HashMap<ElementId, Vec<TimelineLyric>>, song_key: Option<&Key>, next: &mut usize) -> TimelinePart {
    // 时值按首小节 divisions 折算，与演唱顺序的落点同口径
    let div = divisions_of(part);
    let mut time = TimeSig { beats: 4.0, beat_type: 4.0 };
    let mut velocity = DEFAULT_VELOCITY;
    // 移调乐器（`<transpose>`）：记谱音高加这么多半音才是实际发声
    let mut shift = 0.0;
    // 记谱调号（小节 `attrs.key` 接着曲首的）；交出去的是换算成实际发声的
    let mut written = song_key;
    let main_voice = main_voice_of(part);
    let mut measures = vec![];
    for m in &part.measures {
        if let Some(a) = &m.attrs {
            if let Some(t) = &a.time {
                time = TimeSig { beats: t.beats, beat_type: t.beat_type };
            }
            if let Some(t) = &a.transpose {
                shift = t.chromatic + 12.0 * t.octave_change.unwrap_or(0.0);
            }
            if let Some(k) = &a.key {
                written = Some(k);
            }
        }
        let mut dyn_: Vec<(f64, f64)> = m
            .directions
            .iter()
            .flatten()
            .filter(|d| d.kind == "dynamics")
            .filter_map(|d| velocity_of(d.text.as_deref()?).map(|v| (cursor_at(m, d).to_float() + d.offset.unwrap_or(0.0), v)))
            .collect();
        dyn_.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut pos: HashMap<js::NumKey, f64> = HashMap::new();
        let mut chords: Vec<TimelineChord> = vec![];
        for el in &m.elements {
            let Element::Chord(c) = el else { continue };
            // `<forward>` 空出的拍子只记在 `onset` 上（不是隐形休止），不认它后面的音会往前挤
            let key = js::NumKey::new(c.voice);
            let onset = c.onset.or_else(|| pos.get(&key).copied()).unwrap_or(0.0);
            if c.grace.is_some() {
                continue;
            }
            if c.placeholder == Some(true) {
                // 不占时值的占位：自己那一拍不算，身上的增时线延的是前一个音
                let extra = c.duration.divisions - c.duration.divisions / (c.sustains.as_ref().map_or(0, Vec::len) as f64 + 1.0);
                if extra != 0.0 {
                    if let Some(prev) = chords.last_mut() {
                        prev.duration = Some(prev.duration.unwrap().plus(&Fraction::int(extra).div_int(div)));
                    }
                }
                pos.insert(key, onset + extra);
                continue;
            }
            pos.insert(key, onset + c.duration.divisions);
            if c.cue == Some(true) {
                continue;
            }
            let mut v = velocity;
            for &(at, x) in &dyn_ {
                if at <= onset {
                    v = x;
                }
            }
            let mut entry = chord_entry(c, onset, div, v, lead && c.voice <= main_voice, shift, lyrics.get(&c.id), *next);
            *next += 1;
            entry.slur_start = slurs.starts.contains(&c.id);
            entry.slur_ends = slurs.ends.get(&c.id).copied().unwrap_or(0.0);
            chords.push(entry);
        }
        if let Some(&(_, v)) = dyn_.last() {
            velocity = v;
        }
        let duration = chords.iter().map(|e| e.position.plus(&e.duration.unwrap())).reduce(|a, b| if b.compare_to(&a) > 0 { b } else { a });
        measures.push(Some(TimelineMeasure {
            chords,
            duration,
            time,
            key: written.map(|k| TimelineKey { fifths: sounding_fifths(key_fifths(k), shift), minor: is_minor_key(k) }),
        }));
    }
    TimelinePart { measures, name: part.name.clone() }
}

#[allow(clippy::too_many_arguments)]
fn chord_entry(el: &Chord, onset: f64, div: f64, velocity: f64, cursor: bool, shift: f64, phrase_lyrics: Option<&Vec<TimelineLyric>>, ident: usize) -> TimelineChord {
    let mut notes: Vec<TimelineNote> = if el.rest.is_some() {
        vec![]
    } else {
        el.notes
            .iter()
            .filter_map(|n| {
                let p = n.pitch.as_ref()?;
                Some(TimelineNote { pitch: midi_pitch(p) + shift, tie_stop: n.tie.as_ref().and_then(|t| t.stop).unwrap_or(false), lyrics: vec![] })
            })
            .collect()
    };
    // 歌词挂在和弦第一个音上（导出 MIDI 的歌词事件），收尾标点并进前字。断句输入里有的取它那份（`lyrics_of_part`）
    let lyrics: Vec<TimelineLyric> = match phrase_lyrics {
        Some(l) => l.clone(),
        None => {
            let model: Vec<_> = el.lyrics.iter().flatten().filter(|l| !l.text.is_empty()).cloned().collect();
            distinct_numbers(&model)
                .into_iter()
                .map(|l| TimelineLyric {
                    text: format!("{}{}", l.text, l.trailing_punctuation.as_deref().unwrap_or("")),
                    number: l.number,
                    refrain: l.refrain.unwrap_or(false),
                    extend: l.extend.unwrap_or(false),
                })
                .collect()
        }
    };
    if let Some(first) = notes.first_mut() {
        first.lyrics = lyrics;
    }
    TimelineChord {
        ident,
        id: Some(el.id),
        rest: notes.is_empty(),
        notes,
        position: Fraction::int(onset).div_int(div),
        duration: Some(Fraction::int(el.duration.divisions).div_int(div)),
        velocity: Some(velocity),
        cursor: Some(cursor),
        slur_start: false,
        slur_ends: 0.0,
    }
}
