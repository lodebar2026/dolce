//! 试听统一入口 [`play_source_of`]（各格式共用），以及简谱形状的 `ScoreDoc`（文本谱 / 123 / ABC / `.jpwabc`）
//! → 演唱顺序、试听输入（同原 `jianpu/playsong.ts`）。`.jpwabc` 写出端的输入在 `dolce-formats::jpw::input`，用这里的 [`song_measures`]。
//!
//! 与 [`crate::view::playdoc`]（MusicXML 形状）分工同断句那一对；小节序列与断句共用 [`crate::view::phrasesong::build_measures`]。
//! **口径同简谱输入模型 `jianpuinput.ts::jianpuInputOfDoc`**：
//!   - 每个有曲行的声部都算一份（歌词段数取各声部最大值），反复与跳转只看第一份（它在某格没有小节就看那一格的代表小节）；
//!     各份叠在共用时间轴上（`timeaxis`，文本谱一组不一定含全部声部）；`for_expanded` 时带歌词的声部排第一、同号歌词顺延。
//!     试听输入推完演唱顺序后把声部排回模型顺序、主旋律记进 `PlaySource.lead`
//!   - 跳转记号换算同 `applyJumps`；推不出来才退回整曲按段数逐遍
//!
//! 另有两条只归 `.jpwabc` 的：文档自带演唱顺序（`.Repeat`）照它排；`.jpwabc` 没有反复记号整曲按段数逐遍。

use std::collections::HashMap;

use crate::base::js;
use crate::jianpu::written_octave_of;
use crate::keyshift::{fifths_of_spelling, is_minor_key, key_fifths};
use crate::timeaxis::axis_of_song;
use crate::xmlproject::{has_tie_syntax, has_voice_overlay, is_xml_shaped, project_for_music_xml, ProjectOptions};
use crate::{Element, ElementId, Part, PlayPass, ScoreDoc, Song, SourceFormat, Tempo};
use crate::play::jppitch::{key_name_to_fifth, JpKeyState};
use crate::play::playorder::{
    play_order_by_verses, play_order_from_spec, play_order_of, section_play_order, sing_play_order, PlaySpecKind, RepeatSpecItem, SectionMark, TimePosition,
};
use crate::play::timeline::{PlaySource, TimeSig, TimelineKey, TimelinePart};

use crate::view::phrasesong::{build_measures, fail, lines_of_voice, part_of_voice, view_song, voice_numbers, JumpOut, MeasureOut, PitchCtx, ViewResult};
use crate::view::playdata::{jump, locate_section_marks, map_set, play_part_of, sing_specs, timeline_measure_of, zero, PlayData};
use crate::view::playdoc::play_source_of_doc;
use crate::view::slots::{doc_view, DocView, SongView};

#[derive(Debug, Clone, Copy, Default)]
pub struct PlaySongOptions {
    /// 见 `ToScoreOptions.forExpanded`：带歌词的声部当主旋律、同号歌词顺延
    pub for_expanded: bool,
}

/// 一首各声部的小节序列与共用时间轴（`songMeasures`）
pub struct SongMeasures<'a> {
    pub view: &'a SongView,
    /// 调号（fifths；调名 `keys[fifths + 7]`）
    pub key: f64,
    pub time: TimeSig,
    pub voices: Vec<f64>,
    pub parts: Vec<Vec<MeasureOut>>,
    /// 与 `parts` 平行：声部名（MIDI 轨名）
    pub names: Vec<Option<String>>,
    /// 与 `parts` 平行：在模型声部序里排第几（`for_expanded` 把带歌词的声部挪到了第一份）
    pub doc_rank: Vec<usize>,
    /// 第一份声部的跳转记号（小节是它自己的小节序）
    pub jumps: Vec<JumpOut>,
    /// 第一份声部的和弦 → (轴上第几格, 小节内第几个)
    pub id_to_chord: HashMap<ElementId, (usize, usize)>,
    /// 共用时间轴：`slots[k][i]` = 第 k 份第 i 小节落在第几格；一共 `length` 格，每格至少有一份有小节
    pub slots: Vec<Vec<usize>>,
    pub length: usize,
}

/// 曲中转调：模型小节上的调号（第二小节起）按元素 id 交给 `build_measures`。全曲没有转调时不给。
fn key_changes_of(part: Option<&Part>) -> Option<HashMap<ElementId, TimelineKey>> {
    let part = part?;
    let changes = |m: &crate::Measure, i: usize| -> bool {
        m.attrs.as_ref().is_some_and(|a| a.key.is_some()) && (i > 0 || m.print.as_ref().and_then(|p| p.system).unwrap_or(0.0) > 0.0)
    };
    if !part.measures.iter().enumerate().any(|(i, m)| changes(m, i)) {
        return None;
    }
    let mut by_id = HashMap::new();
    let mut key: Option<TimelineKey> = None;
    for (i, m) in part.measures.iter().enumerate() {
        if changes(m, i) {
            let k = m.attrs.as_ref().unwrap().key.as_ref().unwrap();
            key = Some(TimelineKey { fifths: key_fifths(k), minor: is_minor_key(k) });
        }
        let Some(k) = key else { continue };
        for el in &m.elements {
            if let Element::Chord(c) = el {
                by_id.insert(c.id, k);
            }
        }
    }
    Some(by_id)
}

/// 各份小节序列与共用时间轴。`with_pitch`：算 MIDI 音高（试听）。这首没有曲行回 None。
pub fn song_measures<'a>(doc: &'a ScoreDoc, view: &'a DocView, song_idx: usize, options: PlaySongOptions, with_pitch: bool) -> ViewResult<Option<SongMeasures<'a>>> {
    let Some(sv) = view.songs.get(song_idx) else { return Ok(None) };
    let vsong = view_song(doc, view, song_idx).unwrap();
    let doc_song = &doc.songs[song_idx];
    let doc_voices = voice_numbers(sv);
    let mut voices = doc_voices.clone();
    if options.for_expanded {
        if let Some(lead) = voices.iter().copied().find(|&v| lines_of_voice(sv, v).iter().any(|l| !l.line.lyrics.is_empty())) {
            voices.retain(|&v| v != lead);
            voices.insert(0, lead);
        }
    }
    // 调号/拍号同 `songToScore`：全曲一个，取头部
    let meta = &sv.metadata;
    let time = meta.meters.first().map_or(TimeSig { beats: 4.0, beat_type: 4.0 }, |m| TimeSig { beats: m.numerator, beat_type: m.denominator });
    // 调名缺省时取模型的 fifths：`.jpwabc` 来源只记 fifths、不记调名拼写
    let doc_key = doc_song.key.as_ref();
    let mode = meta.mode.as_deref().unwrap_or("C");
    let key = match (meta.mode.is_none(), doc_key) {
        (true, Some(k)) => k.fifths,
        _ => fifths_of_spelling(mode, meta.tonic.as_deref()).unwrap_or_else(|| key_name_to_fifth(mode)),
    };
    let slur_ties = !has_tie_syntax(doc);
    let mut parts = vec![];
    let mut models: Vec<Option<usize>> = vec![];
    let mut names = vec![];
    let mut doc_rank = vec![];
    let mut jumps = vec![];
    for &v in &voices {
        let lines = lines_of_voice(sv, v);
        if lines.is_empty() {
            continue;
        }
        let first = parts.is_empty();
        let model = part_of_voice(doc_song, v);
        let pitch = if with_pitch {
            Some(PitchCtx {
                key: JpKeyState::of_fifths(key).or_else(fail)?,
                time,
                minor: doc_key.is_some_and(is_minor_key),
                key_of: key_changes_of(model.map(|(_, p)| p)),
                slur_ties,
            })
        } else {
            None
        };
        let (mut measures, js_) = build_measures(vsong, &lines, options.for_expanded, pitch)?;
        // 八度谱号的声部（四声部简谱的男高、男低按高八度记）实际低八度发声
        let oc = if with_pitch { model.map_or(0.0, |(_, p)| written_octave_of(p)) } else { 0.0 };
        if oc != 0.0 {
            for n in measures.iter_mut().flat_map(|m| m.entries.iter_mut()).flat_map(|c| c.notes.iter_mut()) {
                if n.pitch > 0.0 {
                    n.pitch += 12.0 * oc;
                }
            }
        }
        if first {
            jumps = js_;
        }
        parts.push(measures);
        models.push(model.map(|(i, _)| i));
        names.push(model.and_then(|(_, p)| p.name.clone()));
        doc_rank.push(doc_voices.iter().position(|&x| x == v).unwrap_or(usize::MAX));
    }
    if parts.is_empty() {
        return Ok(None);
    }
    let (slots, length) = axis_of_measures(doc_song, &models, &parts);
    let mut id_to_chord = HashMap::new();
    for (measure, m) in parts[0].iter().enumerate() {
        for (index, ch) in m.entries.iter().enumerate() {
            if let Some(id) = ch.id {
                id_to_chord.insert(id, (slots[0][measure], index));
            }
        }
    }
    Ok(Some(SongMeasures { view: sv, key, time, voices, parts, names, doc_rank, jumps, id_to_chord, slots, length }))
}

/// 各份小节序列在共用时间轴上的格：小节按首个和弦的元素 id 找回模型小节、取它的格。
/// 不按组排的谱各份照自己的小节序号一一对应。一格都没有小节的压掉，保证每格至少有一份。
fn axis_of_measures(song: &Song, models: &[Option<usize>], parts: &[Vec<MeasureOut>]) -> (Vec<Vec<usize>>, usize) {
    let axis = axis_of_song(song);
    if !axis.grouped {
        return (parts.iter().map(|ms| (0..ms.len()).collect()).collect(), parts.iter().map(Vec::len).max().unwrap_or(0));
    }
    let raw: Vec<Vec<i64>> = parts
        .iter()
        .enumerate()
        .map(|(k, ms)| {
            let mut slot_of: HashMap<ElementId, usize> = HashMap::new();
            if let Some(pi) = models[k] {
                for (i, m) in song.parts[pi].measures.iter().enumerate() {
                    for el in &m.elements {
                        slot_of.insert(el.id(), axis.slot[pi][i]);
                    }
                }
            }
            let mut prev: i64 = -1;
            ms.iter()
                .map(|m| {
                    let hit = m.entries.iter().find_map(|ch| ch.id.and_then(|id| slot_of.get(&id).copied()));
                    prev = (hit.map_or(prev + 1, |g| g as i64)).max(prev + 1);
                    prev
                })
                .collect()
        })
        .collect();
    let mut used: Vec<i64> = raw.iter().flatten().copied().collect();
    used.sort();
    used.dedup();
    let rank: HashMap<i64, usize> = used.iter().enumerate().map(|(i, &g)| (g, i)).collect();
    (raw.iter().map(|s| s.iter().map(|g| rank[g]).collect()).collect(), used.len())
}

/// 轴上每一格的「代表小节」：第一份的，第一份在这一格没有小节就取后面第一个有的
fn lead_on_axis<'b>(built: &'b SongMeasures) -> Vec<Option<&'b MeasureOut>> {
    let mut out: Vec<Option<&MeasureOut>> = vec![None; built.length];
    for (k, ms) in built.parts.iter().enumerate() {
        for (i, m) in ms.iter().enumerate() {
            let g = built.slots[k][i];
            if out[g].is_none() {
                out[g] = Some(m);
            }
        }
    }
    out
}

/// 轴上推的演唱顺序 → 第一份声部自己的小节序（它每格都有小节时原样返回）。
pub fn fold_to_first_part(pd: PlayData, built: &SongMeasures) -> ViewResult<PlayData> {
    let mine = &built.slots[0];
    let length = built.length;
    if mine.len() == length {
        return Ok(pd);
    }
    let mut local: Vec<i64> = vec![-1; length];
    for (i, &g) in mine.iter().enumerate() {
        local[g] = i as i64;
    }
    // 第 g 格往后（含）第一个有小节的格，没有就是小节总数
    let next_local = |g: f64| -> f64 {
        let mut s = g.max(0.0) as usize;
        while s < length {
            if local[s] >= 0 {
                return local[s] as f64;
            }
            s += 1;
        }
        mine.len() as f64
    };
    let loc = |g: f64| -> i64 { js::index(g).and_then(|i| local.get(i).copied()).unwrap_or(-1) };
    let mut out = PlayData { has_repeat: pd.has_repeat, is_simple: pd.is_simple, tempo: pd.tempo, from_sections: pd.from_sections, ..PlayData::default() };
    for it in &pd.measures {
        let mut have: Vec<f64> = vec![];
        let mut g = it.mid;
        while g < it.end {
            if loc(g) >= 0 {
                have.push(g);
            }
            g += 1.0;
        }
        if have.is_empty() {
            if let Some(prev) = out.measures.last_mut() {
                if it.end_of_pass {
                    prev.end_of_pass = true;
                }
            }
            continue;
        }
        let mut c = it.clone();
        c.mid = loc(have[0]) as f64;
        c.end = loc(*have.last().unwrap()) as f64 + 1.0;
        if have[0] != it.mid {
            c.offset = zero();
            c.skip = 0.0;
        }
        if *have.last().unwrap() != it.end - 1.0 {
            c.limit = -1.0;
        }
        if it.glue_from >= 0.0 {
            c.glue_from = js::min(next_local(it.glue_from), c.end);
        }
        if let Some(si) = it.scope {
            let set: Vec<f64> = pd.scopes[si].iter().filter(|&&g| loc(g) >= 0).map(|&g| loc(g) as f64).collect();
            c.scope = Some(out.scopes.len());
            out.scopes.push(set);
        }
        out.measures.push(c);
    }
    let mv = |t: &TimePosition| -> ViewResult<TimePosition> {
        let m = next_local(t.mid);
        TimePosition::new(m, if loc(t.mid) >= 0 { t.offset } else { zero() })
    };
    for (k, t) in &pd.segno {
        map_set(&mut out.segno, k, mv(t)?);
    }
    for (k, t) in &pd.coda {
        map_set(&mut out.coda, k, mv(t)?);
    }
    for (t, v) in &pd.jump_to {
        out.jump_to.push((mv(t)?, v.clone()));
    }
    Ok(out)
}

/// 段落标记 → 轴上的格。写在主旋律以外声部的小节中间时贴到小节头：`skip` 数的是主旋律的和弦。
fn section_marks_of(song: &Song, built: &SongMeasures) -> Vec<SectionMark> {
    let mut where_: HashMap<ElementId, (usize, f64, f64)> = HashMap::new();
    for (k, ms) in built.parts.iter().enumerate() {
        for (i, m) in ms.iter().enumerate() {
            for (index, ch) in m.entries.iter().enumerate() {
                if let Some(id) = ch.id {
                    where_.insert(id, (built.doc_rank[k], built.slots[k][i] as f64, if k == 0 { index as f64 } else { 0.0 }));
                }
            }
        }
    }
    locate_section_marks(song, |id| where_.get(&id).copied())
}

/// 演唱顺序（未折回第一份声部）。`use_sections`：按头部 `P:` 排
pub fn play_data_of(doc: &ScoreDoc, song_idx: usize, built: &SongMeasures, use_sections: bool) -> ViewResult<PlayData> {
    let main = lead_on_axis(built);
    let mut pd = PlayData::default();
    let doc_song = &doc.songs[song_idx];
    let main_part = || play_part_of(&main);
    // 逐遍演唱顺序（123 `%%sing`）：逐页逐行写定的，优先于 `P:` 与谱面记号
    if doc_song.sing_order.as_ref().is_some_and(|s| !s.is_empty()) {
        let order = sing_play_order(&[main_part()], &section_marks_of(doc_song, built), &sing_specs(doc_song))?;
        if !order.is_empty() {
            pd.measures = order;
            pd.from_sing = true;
            pd.from_sections = true;
            return Ok(pd);
        }
    }
    if let Some(po) = doc_song.play_order.as_ref().filter(|p| !p.is_empty()) {
        let items: Vec<RepeatSpecItem> = po.iter().map(|p| spec_item(p, &built.id_to_chord)).collect();
        pd.measures = play_order_from_spec(&items, Some(&main_part()));
        return Ok(pd);
    }
    // 段数 = 主旋律歌词最多的那一行的段号上限
    let mut passes: f64 = 0.0;
    for line in lines_of_voice(built.view, built.voices[0]) {
        for l in &line.line.lyrics {
            passes = js::max(passes, l.verse_to);
        }
    }
    // `.jpwabc` 没有 `.Repeat`：谱里没有反复记号就整曲按段数逐遍；有 `|: :|` 的照反复记号推（用户定，2026-10-14）
    let jpw = doc.source_format == SourceFormat::Jpwabc;
    if jpw && !main.iter().any(|m| m.is_some_and(|m| m.repeat_backward)) {
        pd.measures = play_order_by_verses(main.len() as f64, passes);
        pd.is_simple = true;
        return Ok(pd);
    }

    let jumps: Vec<JumpOut> = built.jumps.iter().map(|j| JumpOut { measure: built.slots[0][j.measure], ..j.clone() }).collect();
    apply_jumps(&mut pd, &main, &jumps)?;
    let attempt = (|| -> ViewResult<()> {
        let mut play_parts = vec![main_part()];
        for (k, ms) in built.parts.iter().enumerate().skip(1) {
            let spread = crate::timeaxis::spread_on_axis(&ms.iter().collect::<Vec<_>>(), &built.slots[k], built.length);
            play_parts.push(play_part_of(&spread));
        }
        let seq: Vec<String> = if use_sections { doc_song.section_order.as_ref().map(|s| s.seq.clone()).unwrap_or_default() } else { vec![] };
        let by_sections = if seq.is_empty() { None } else { section_play_order(&play_parts, &pd.jumps(), &seq, &section_marks_of(doc_song, built))? };
        pd.from_sections = by_sections.is_some();
        let order = match by_sections {
            Some(o) => o,
            None => play_order_of(&play_parts, &pd.jumps())?,
        };
        let has_repeat = order.has_repeat;
        pd.take_order(order);
        // `.jpwabc` 读进来按反复记号推的顺序，重读时照样推得出来：不算「有反复」，写出端就不另补 `.Repeat`（往返定点）
        pd.has_repeat = has_repeat && !jpw;
        Ok(())
    })();
    if attempt.is_ok() && !pd.measures.is_empty() {
        return Ok(pd);
    }
    pd.measures = play_order_by_verses(main.len() as f64, js::max(1.0, passes));
    pd.is_simple = true;
    Ok(pd)
}

/// `PlayPass` → `.Repeat` 的一条（小节 1 基 → 0 基；接入/收尾的元素 id → 小节内和弦序号）
fn spec_item(p: &PlayPass, id_to_chord: &HashMap<ElementId, (usize, usize)>) -> RepeatSpecItem {
    let from = p.from_element.and_then(|id| id_to_chord.get(&id));
    let to = p.to_element.and_then(|id| id_to_chord.get(&id));
    RepeatSpecItem {
        first: p.from_measure - 1.0,
        last: p.to_measure - 1.0,
        verse: p.verse.unwrap_or(0.0),
        skip: from.map_or(0.0, |f| f.1 as f64),
        page: p.page_break_after.unwrap_or(false),
        limit: to.map_or(-1.0, |t| t.1 as f64 + 1.0),
    }
}

/// 跳转记号 → 演唱顺序的跳转表
fn apply_jumps(pd: &mut PlayData, measures: &[Option<&MeasureOut>], jumps: &[JumpOut]) -> ViewResult<()> {
    let count = measures.len();
    let end = |mid: usize| -> ViewResult<TimePosition> {
        let Some(Some(m)) = measures.get(mid) else { return fail("measure has no chord") };
        Ok(TimePosition { mid: mid as f64, offset: m.duration()? })
    };
    let target = |j: &JumpOut| -> TimePosition {
        if j.on_barline && j.measure + 1 < count {
            TimePosition { mid: (j.measure + 1) as f64, offset: zero() }
        } else {
            TimePosition { mid: j.measure as f64, offset: zero() }
        }
    };
    let codas: Vec<usize> = jumps.iter().enumerate().filter(|(_, j)| j.name == "ty").map(|(i, _)| i).collect();
    for (i, j) in jumps.iter().enumerate() {
        match j.name.as_str() {
            "dc" => pd.jump_to.push((end(j.measure)?, jump(PlaySpecKind::Dacapo, None))),
            "fine" => pd.jump_to.push((end(j.measure)?, jump(PlaySpecKind::Fine, None))),
            "ds" => pd.jump_to.push((end(j.measure)?, jump(PlaySpecKind::DalSegno, Some("1")))),
            "hs" => map_set(&mut pd.segno, "1", target(j)),
            "ty" => {
                // 两处尾声记号：前一处是 To Coda，后一处是尾声的起点；只有一处就只当起点
                if codas.len() >= 2 && i == codas[0] {
                    pd.jump_to.push((end(j.measure)?, jump(PlaySpecKind::ToCoda, Some("1"))));
                } else {
                    map_set(&mut pd.coda, "1", target(j));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// 演唱顺序（`measures` / `isSimpple` / `hasRepeat` 与跳转表；速度不在这里）。这首没有曲行时回 None。
/// 在共用时间轴上推，小节下标折回第一份声部（`for_expanded` 时是带歌词的那个）自己的小节序：投影档、`.jpwabc` 只排它。
pub fn play_data_of_song(doc: &ScoreDoc, view: &DocView, song_idx: usize, options: PlaySongOptions) -> ViewResult<Option<PlayData>> {
    let Some(built) = song_measures(doc, view, song_idx, options, false)? else { return Ok(None) };
    let pd = play_data_of(doc, song_idx, &built, true)?;
    fold_to_first_part(pd, &built).map(Some)
}

/// 谱面速度：头部第一个 20..400 的数
pub fn tempo_of_meta(tempos: &[Tempo]) -> Option<f64> {
    tempos.iter().find_map(|t| match t {
        Tempo::Bpm(b) if *b >= 20.0 && *b <= 400.0 => Some(*b),
        _ => None,
    })
}

/// 歌词的续记号（`_`）从模型补到小节序列的字上（导出 MIDI 判一字多音用）。
/// 按元素 id 找回模型的和弦，再按字与段号认是哪一条（`C1-2:` 一条词展开成几段，不能按下标）。
fn mark_extends(song: &Song, parts: &mut [Vec<MeasureOut>]) {
    let mut by_id: HashMap<ElementId, &crate::Chord> = HashMap::new();
    for p in &song.parts {
        for m in &p.measures {
            for el in &m.elements {
                if let Element::Chord(c) = el {
                    by_id.insert(c.id, c);
                }
            }
        }
    }
    for ch in parts.iter_mut().flatten().flat_map(|m| m.entries.iter_mut()) {
        let Some(c) = ch.id.and_then(|id| by_id.get(&id)) else { continue };
        let model: Vec<&crate::Lyric> = c.lyrics.iter().flatten().filter(|l| l.extend == Some(true) && !l.text.is_empty()).collect();
        if model.is_empty() {
            continue;
        }
        for l in ch.notes[0].lyrics.iter_mut() {
            let same: Vec<&&crate::Lyric> = model.iter().filter(|x| format!("{}{}", x.text, x.trailing_punctuation.as_deref().unwrap_or("")) == l.text).collect();
            let hit = same.iter().find(|x| x.number <= l.number && l.number <= x.number_to.unwrap_or(x.number)).or(same.first());
            if hit.is_some() {
                l.extend = true;
            }
        }
    }
}

/// 试听/MIDI 的输入：各声部小节序列 + 演唱顺序 + 速度，和弦带元素 id。连同推出来的 [`PlayData`]（未折回）一起回。
pub fn play_source_of_song(doc: &ScoreDoc, view: &DocView, song_idx: usize, options: PlaySongOptions) -> ViewResult<Option<(PlaySource, PlayData)>> {
    let Some(mut built) = song_measures(doc, view, song_idx, options, true)? else { return Ok(None) };
    mark_extends(&doc.songs[song_idx], &mut built.parts);
    let mut pd = play_data_of(doc, song_idx, &built, true)?;
    if let Some(t) = tempo_of_meta(&built.view.metadata.tempos) {
        pd.tempo = t;
    }
    // 演唱顺序按「带歌词的声部在前」推好了；交出去时声部排回模型的顺序（声部面板、MIDI 轨序按它），主旋律另记
    let mut order: Vec<usize> = (0..built.parts.len()).collect();
    order.sort_by_key(|&i| built.doc_rank[i]);
    let mut next = 0usize;
    let parts = order
        .iter()
        .map(|&i| {
            let ms: Vec<_> = built.parts[i].iter().map(|m| timeline_measure_of(m, &mut next)).collect();
            TimelinePart { measures: crate::timeaxis::spread_on_axis(&ms, &built.slots[i], built.length), name: built.names[i].clone() }
        })
        .collect();
    let lead = order.iter().position(|&i| i == 0);
    Ok(Some((PlaySource { parts, play_data: pd.source_order(), lead }, pd)))
}

/// **试听/MIDI 的统一入口**（各格式共用）：MusicXML 形状走 [`play_source_of_doc`]（全部声部、voice 与力度），
/// 简谱形状走 [`play_source_of_song`]。拼不出（这首没有曲行）回 None。
pub fn play_source_of(doc: &ScoreDoc, song_idx: usize, options: PlaySongOptions) -> ViewResult<Option<(PlaySource, PlayData)>> {
    let Some(song) = doc.songs.get(song_idx) else { return Ok(None) };
    if is_xml_shaped(song) {
        return play_source_of_doc(song, false).map(Some);
    }
    // ABC `&` 的临时多声部、大谱表（`V:2 part=1`）与和音（`[CEG]`）：简谱那条路一个声部行只走一条旋律、一个和弦只响一个音。
    // 先投成 MusicXML 形状（元素 id 不变，高亮照样认得）再按 voice 分轨播
    let chordal = song.parts.iter().any(|p| {
        p.measures.iter().any(|m| m.elements.iter().any(|el| matches!(el, Element::Chord(c) if c.rhythm != Some(true) && c.notes.len() > 1)))
    });
    if has_voice_overlay(song) || song.parts.iter().any(|p| p.staff_of.as_deref().is_some_and(|s| !s.is_empty())) || chordal {
        let projected = project_for_music_xml(song, &ProjectOptions { slur_ties: Some(!has_tie_syntax(doc)), ..Default::default() })
            .map_err(|m| crate::play::PlayError(m.key.to_string()))?;
        return play_source_of_doc(&projected, false).map(Some);
    }
    let view = doc_view(doc, None);
    play_source_of_song(doc, &view, song_idx, options)
}

