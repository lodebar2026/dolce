//! 简谱识别结果 → `ScoreDoc`（**简谱形状**，与 123 解析的产物同口径：度数、48 分时值、增时线、减时线）。
//!
//! 识别出来的本来就是简谱：数字、八度点、减时线、增时线。直出模型，123 核对文本 = `emit_123(本模块产物)`，
//! 要 MusicXML 就走唯一写出端 `dolce-model::toxml`（经 `xmlproject` 投影）。
//! 以前先拼成 MusicXML 再读回来、由 `jianpuproject` 猜回简谱形状——附点加增时线（2.5 拍）这种 `<type>` 表达不了的时值就丢了半拍，
//! 速度、副标题、段落词、歌词段号在 MusicXML 读回那一步也全丢。
//!
//! 音符次序：`flat` 下标 = 全曲 `rows[].nums` 拍平后的第几个（`JpwMeta` 的约定），[`Built::num_of`] 与 [`chord_places`] 都按它。
use dolce_base::js;
use dolce_formats::abc::dialect::duration_123;
use dolce_model::doc::*;
use dolce_model::helpers::{empty_doc, IdGen};
use dolce_model::metakeys::creator_of;
use dolce_omr_sheet::jianpu::{JpNum, RecognizedScore, StaffRow, RHYTHM_DIGIT};
use dolce_play::jppitch::jp_pitch;
use std::collections::{HashMap, HashSet};

const Q: f64 = SIMPLE_DIVISIONS;

/// 建模结果：模型，以及各和弦来自哪个识别符号（小节时值自检要按源图坐标标出问题小节；`flat` 下标）。
pub struct Built {
    pub doc: ScoreDoc,
    pub num_of: Vec<(ElementId, usize)>,
}

/// 拍平后的音符：`flat` 下标 → 音符。
struct Flat<'a> {
    nums: Vec<&'a JpNum>,
    /// 每行第一个音符的 `flat` 下标
    row_base: Vec<usize>,
}

impl<'a> Flat<'a> {
    fn of(score: &'a RecognizedScore) -> Self {
        let mut nums = Vec::new();
        let mut row_base = Vec::with_capacity(score.rows.len());
        for r in &score.rows {
            row_base.push(nums.len());
            nums.extend(r.nums.iter());
        }
        Flat { nums, row_base }
    }
}

/// 一行切出来的一个小节：音符（`flat` 下标），以及它右边界那根线的 x（行末开口收尾时为 None）。
/// `silent`：声部行里整小节不唱的空小节，写成整小节隐形休止。
struct RowMeasure {
    notes: Vec<usize>,
    right_x: Option<f64>,
    silent: bool,
}

/// 把一行按小节线 x 切成小节。
fn measures_of_row(row: &StaffRow, base: usize) -> Vec<RowMeasure> {
    let xs = &row.barline_xs;
    if xs.is_empty() {
        return vec![RowMeasure { notes: (base..base + row.nums.len()).collect(), right_x: None, silent: false }];
    }
    let mut measures: Vec<RowMeasure> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut bi = 0;
    for (k, n) in row.nums.iter().enumerate() {
        while bi < xs.len() && n.bbox.x > xs[bi] {
            measures.push(RowMeasure { notes: std::mem::take(&mut cur), right_x: Some(xs[bi]), silent: false });
            bi += 1;
        }
        cur.push(base + k);
    }
    // 静默声部行（整行只有休止，新编赞美诗·四声部 12 第 3 系统 B 声部只印行首 `0`）逐根切开，空小节写成整小节不唱，
    // 要占住小节，否则同系统各声部小节数对不上、后面整首错位。只认这种行：普通声部行末小节空着多是音没读出来，
    // 补隐形休止反倒把小节对位搅乱（144、396、f32 末小节）。首音之前的空档不算（页边、连谱号常被收成线，56 首系统 x=4、123）。
    let silent_row = row.voice.is_some() && !row.nums.is_empty() && row.nums.iter().all(|n| n.digit == 0);
    if silent_row {
        while bi + 1 < xs.len() {
            measures.push(RowMeasure { notes: std::mem::take(&mut cur), right_x: Some(xs[bi]), silent: false });
            bi += 1;
        }
    }
    // 行末剩下的线（若最后一个音符右侧还有线）里取最后一根：那才是本行末小节的右界。
    measures.push(RowMeasure { notes: cur, right_x: if bi < xs.len() { xs.last().copied() } else { None }, silent: false });
    // 空小节（复纵线/终止线并排两根之间切出来的）不成节，但它的右界要**顺延给前一个小节**——
    // 否则小节右界停在左边那根上，认不出复纵线（double_bar_xs 记的是右边那根）。
    let mut out: Vec<RowMeasure> = Vec::new();
    let wide = (row.bottom_y - row.top_y) * 1.5;
    let mut left_x: Option<f64> = None;
    for m in measures {
        let right = m.right_x;
        if !m.notes.is_empty() {
            out.push(m);
        } else if silent_row && matches!((left_x, m.right_x), (Some(l), Some(r)) if r - l >= wide) && !out.is_empty() {
            out.push(RowMeasure { silent: true, ..m });
        } else if let (Some(last), Some(r)) = (out.last_mut(), m.right_x) {
            last.right_x = Some(r);
        }
        left_x = right;
    }
    out
}

/// 一行是否以小节线收尾（最后一个音符右侧仍有小节线）。否→末小节是「开口」的，
/// 即该小节跨行延续到下一行行首（弱起/续句），换行处图上本就没有小节线，不可补。
fn row_ends_closed(row: &StaffRow) -> bool {
    let (Some(last), false) = (row.nums.last(), row.barline_xs.is_empty()) else { return false };
    let max = row.barline_xs.iter().copied().fold(f64::NEG_INFINITY, js::max);
    max >= last.bbox.x + last.bbox.w
}

/// 弧线配对结果：slur 的 number（嵌套双弧时一个音符可收/起多条，故是数组），以及配上对、可以输出的 tie 端点。
#[derive(Default)]
struct ArcPairs {
    slur: HashMap<usize, (Vec<u32>, Vec<u32>)>,
    tie: HashMap<usize, (bool, bool)>,
}

/// 全曲把 slur/tie 配成对。
///
/// 识别难免出错：《主祢真伟大》识别出的 slur 虽然 start/stop 各 5 个，配对却错位（嵌套到深度 2
/// 且最后剩一个没闭合）——一条弧的 stop 被算给了错误的 start，就画出一条横跨很远的弧线。
/// 所以这里：栈式配对（后开先闭）、给 slur 编 `number`、**配不上对的一律剔除**。
///
/// tie 还多一条：延音线两端音高必须相同。识别把两端读成不同音时那不是延音线，硬输出只会得到一条莫名其妙的长弧，剔除。
fn pair_arcs(order: &[usize], flat: &Flat, fifths: f64) -> ArcPairs {
    let mut a = ArcPairs::default();
    #[derive(PartialEq)]
    enum Key {
        Rest,
        Rhythm,
        Pitch(Option<&'static str>, f64, f64),
    }
    let key_of = |n: &JpNum| {
        if n.digit == 0 {
            Key::Rest
        } else if n.digit == RHYTHM_DIGIT {
            Key::Rhythm
        } else {
            let p = jp_pitch(n.digit as f64, n.octave as f64, fifths);
            Key::Pitch(p.step, p.alter, p.octave)
        }
    };
    // (number, 起始音符, 这条弧是否已作废)
    let mut open_slur: Vec<(u32, usize, bool)> = Vec::new();
    let mut open_tie: Vec<usize> = Vec::new();
    // 起点作废：把它那条 number 从起点音符的 starts 里摘掉（一个音符可能起了不止一条）。
    let drop_slur_start = |a: &mut ArcPairs, n: usize, k: u32| {
        if let Some(s) = a.slur.get_mut(&n) {
            s.0.retain(|&v| v != k);
        }
    };
    for &i in order {
        let n = flat.nums[i];
        // 嵌套双弧（外弧罩三音、内弧只罩后两音）在末音上同时收两条，故按条数循环。
        for _ in 0..n.slur_stop {
            // 端点落在休止符上的圆滑线是**识别错误**（弧线本该连到旁边的音符），整条作废——
            // 只丢一端会剩半条弧，一路拖到下一条 slur 那里去。
            // 注：人工写的谱里 slur 连休止符是合法的，只有识别这一路做这个剔除。
            match open_slur.pop() {
                None => {}
                Some((k, from, dead)) if dead || n.digit == 0 => drop_slur_start(&mut a, from, k),
                Some((k, _, _)) => a.slur.entry(i).or_default().1.push(k),
            }
        }
        for _ in 0..n.slur_start {
            let mut k = 1;
            while open_slur.iter().any(|o| o.0 == k) {
                k += 1;
            }
            open_slur.push((k, i, n.digit == 0));
            a.slur.entry(i).or_default().0.push(k);
        }
        if n.tie_stop {
            let from = open_tie.pop();
            // 两端音高必须相同，且都不能是休止符（延音线连到休止符没有意义）。
            match from {
                Some(f) if n.digit != 0 && n.digit != RHYTHM_DIGIT && key_of(flat.nums[f]) == key_of(n) => a.tie.entry(i).or_default().1 = true,
                // 音高不符：两端一起剔除
                Some(f) => {
                    if let Some(s) = a.tie.get_mut(&f) {
                        s.0 = false;
                    }
                }
                None => {}
            }
        }
        if n.tie_start && n.digit != 0 && n.digit != RHYTHM_DIGIT {
            open_tie.push(i);
            a.tie.entry(i).or_default().0 = true;
        }
    }
    for (k, n, _) in open_slur {
        drop_slur_start(&mut a, n, k);
    }
    for n in open_tie {
        if let Some(s) = a.tie.get_mut(&n) {
            s.0 = false;
        }
    }
    a
}

/// 跳转记号 → 小节线上的记号原名（`xmlproject::direction_of` 认的那几个，导出 MusicXML 时落成 `<direction>`+`<sound>`）。
fn jump_ornament(j: &str) -> Option<&'static str> {
    match j {
        "D.C." => Some("dc"),
        "D.S." => Some("ds"),
        "Fine" => Some("fine"),
        "To Coda" => Some("ty"),
        _ => None,
    }
}

/// 倚音底下的减时线条数 → 符号时值
fn grace_type(div: u32) -> Option<NoteType> {
    match div {
        1 => Some(NoteType::Eighth),
        2 => Some(NoteType::N16th),
        3 => Some(NoteType::N32nd),
        _ => None,
    }
}

fn chord_symbol(text: &str) -> Harmony {
    Harmony { root: HarmonyStep { step: "C".into(), alter: 0.0, alter_left: None }, kind: String::new(), text: Some(text.to_owned()), ..Default::default() }
}

/// 一个和弦名落在哪：音符本身、第 k 条增时线、写不出的后续和弦第 k 个（`Chord.later_harmonies`）。
/// 序列化成 TS 的 `"h"` / `"s<k>"` / `"l<k>"`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChordPlace {
    Head,
    Sustain(usize),
    Later(usize),
}

impl ChordPlace {
    pub fn code(&self) -> String {
        match self {
            ChordPlace::Head => "h".into(),
            ChordPlace::Sustain(k) => format!("s{k}"),
            ChordPlace::Later(k) => format!("l{k}"),
        }
    }
}

/// 和弦落点。识别给的是「本音符时值内的比例」：主和弦 `chord_offset`、长音上逐拍换的 `extra_chords`。
/// 简谱侧只有两个位置可挂：音符本身、它的某条增时线（`Sustain.harmony`）。
/// - 正落在第 k 条增时线那一拍上 → 挂那条增时线；
/// - 落不到整拍上的：音符本身还空着就挂音符（位置提前了，但和弦还在谱上），否则留在 `later_harmonies`（123 写不出）。
///
/// 长音里的后续和弦印在增时线上方，必落在**整拍**上：先量化到拍，免得插值出的 1.89 拍哪条增时线都挂不上。
///
/// 返回与 `[chord, ...extra_chords]` 同序的落点。识别核对按它把源图和弦框认回模型（TS `reproject.ts::chordSlots`）：
/// 按「这个音的第几个和弦」数的话，删掉前面一个，后面的就错位一格。
pub fn chord_places_of(n: &JpNum) -> Vec<ChordPlace> {
    if n.chord.as_deref().is_none_or(str::is_empty) {
        return Vec::new();
    }
    let sustain_count = if n.digit == 0 { 0 } else { n.augment as usize };
    let dur = duration_123(n.div, u32::from(n.dot > 0), sustain_count);
    let full = match &n.tuplet {
        Some(t) => js::round(dur.divisions * t.normal as f64 / t.actual as f64),
        None => dur.divisions,
    };
    let body = (dur.divisions - sustain_count as f64 * Q) / Q; // 本体时值（拍）
    let mut offsets = vec![js::round(n.chord_offset.unwrap_or(0.0) * full)];
    offsets.extend(n.extra_chords.iter().map(|c| js::max(0.0, js::min(js::round(c.offset * full / Q) * Q, full - 1.0))));
    let mut out: Vec<Option<ChordPlace>> = vec![None; offsets.len()];
    let mut head = false;
    let mut taken = HashSet::new();
    let mut later: Vec<usize> = Vec::new();
    for (idx, &offset) in offsets.iter().enumerate() {
        if offset <= 0.0 && !head {
            head = true;
            out[idx] = Some(ChordPlace::Head);
            continue;
        }
        let at = offset / Q;
        let k = js::round(at - body);
        if (at - body - k).abs() < 1e-6 && k >= 0.0 && k < sustain_count as f64 && !taken.contains(&(k as usize)) {
            taken.insert(k as usize);
            out[idx] = Some(ChordPlace::Sustain(k as usize));
        } else {
            later.push(idx);
        }
    }
    if !head && !later.is_empty() {
        out[later.remove(0)] = Some(ChordPlace::Head);
    }
    for (k, idx) in later.into_iter().enumerate() {
        out[idx] = Some(ChordPlace::Later(k));
    }
    out.into_iter().map(|p| p.unwrap_or(ChordPlace::Head)).collect()
}

/// 全曲各音符（`flat` 序）的和弦落点。
pub fn chord_places(score: &RecognizedScore) -> Vec<Vec<ChordPlace>> {
    score.rows.iter().flat_map(|r| r.nums.iter()).map(chord_places_of).collect()
}

fn place_chords(n: &JpNum, ch: &mut Chord) {
    let texts: Vec<&str> = match n.chord.as_deref() {
        Some(c) if !c.is_empty() => std::iter::once(c).chain(n.extra_chords.iter().map(|c| c.tok.as_str())).collect(),
        _ => Vec::new(),
    };
    for (idx, place) in chord_places_of(n).into_iter().enumerate() {
        let h = chord_symbol(texts[idx]);
        match place {
            ChordPlace::Head => ch.harmony = Some(h),
            ChordPlace::Sustain(k) => {
                if let Some(s) = ch.sustains.as_mut().and_then(|v| v.get_mut(k)) {
                    s.harmony = Some(h);
                }
            }
            ChordPlace::Later(_) => ch.later_harmonies.get_or_insert_with(Vec::new).push(h),
        }
    }
}

fn truthy(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|s| !s.is_empty())
}

fn new_chord(id: ElementId, duration: Duration) -> Chord {
    Chord { id, duration, voice: 1.0, staff: 1.0, ..Default::default() }
}

fn rest_chord(id: ElementId, divisions: f64) -> Chord {
    Chord { rest: Some(RestInfo::default()), ..new_chord(id, Duration { divisions, kind: None, dots: 0.0, time_mod: None }) }
}

fn new_sustain(id: ElementId) -> Sustain {
    Sustain {
        id,
        harmony: None,
        notations: None,
        ornaments: None,
        section_word: None,
        lyric_anchor: None,
        lyrics: None,
        before: None,
        line_break_after: None,
        attached_sources: None,
        source: None,
    }
}

fn empty_page_text() -> PageText {
    PageText::default()
}

/// 识别结果 → 模型。
pub fn recognized_to_doc(score: &RecognizedScore) -> Built {
    let flat = Flat::of(score);
    let mut ids = IdGen::new();
    let mut marks: Vec<Mark> = Vec::new();
    let mut num_of: Vec<(ElementId, usize)> = Vec::new();
    // 多声部（`StaffRow.voice`，四声部诗歌本）：每个声部各取自己那几行建一个 part，行序即谱面系统序；
    // 弧、换行、跨行小节都在声部内部算。歌词挂在歌词带上方那一行（第 2 声部），与文本谱 `Q2` 后跟 `C1:` 一致。
    let mut voices: Vec<u32> = score.rows.iter().map(|r| r.voice.unwrap_or(0)).collect();
    voices.sort_unstable();
    voices.dedup();
    // 局部多声部（946《大地音韵飘》前两行单声部、副歌两个系统分两声部）：没归系统的行只进第 1 声部，各声部的小节数就对不上了。
    // 按谱面自上而下给每行编组号（同一系统的几行一组，单声部行各成一组），挂在行首小节的 `print.system` 上，
    // 共用时间轴按组对齐（`dolce-model::timeaxis`，同文本谱一组只写 `Q:` 的口径）。整页都分了声部的不挂，照旧按小节序号一一对应。
    let mut group_of: Option<HashMap<usize, u32>> = None;
    if voices.len() > 1 && score.rows.iter().any(|r| r.voice.is_none()) {
        let mut order: Vec<usize> = (0..score.rows.len()).collect();
        order.sort_by(|&a, &b| score.rows[a].top_y.partial_cmp(&score.rows[b].top_y).unwrap_or(std::cmp::Ordering::Equal));
        let mut m = HashMap::new();
        let (mut g, mut sys): (i64, Option<u32>) = (-1, None);
        for ri in order {
            let r = &score.rows[ri];
            if r.system.is_none() || r.system != sys {
                g += 1;
            }
            sys = r.system;
            m.insert(ri, g as u32);
        }
        group_of = Some(m);
    }
    let mut parts: Vec<Part> = voices
        .iter()
        .enumerate()
        .map(|(pi, &v)| {
            let rows: Vec<usize> = (0..score.rows.len()).filter(|&ri| score.rows[ri].voice.unwrap_or(0) == v).collect();
            let measures = measures_of_rows(&rows, score, &flat, &mut ids, &mut marks, &mut num_of, group_of.as_ref());
            Part { id: format!("P{}", pi + 1), measures, ..Default::default() }
        })
        .collect();
    // 四声部简谱（女高、女低、男高、男低）：男声两部照惯例按高八度记，标上八度谱号（123 `V:3 clef=treble-8`），
    // 试听与五线谱据此落回实际八度（`jianpu::written_octave_of`）。二、三声部的谱看不出哪部是男声，不标。
    if parts.len() == 4 {
        for p in &mut parts[2..] {
            if let Some(first) = p.measures.first_mut() {
                first.attrs.get_or_insert_with(Default::default).clefs = Some(vec![Clef { sign: ClefSign::G, line: Some(2.0), octave_change: Some(-1.0), staff: None }]);
            }
        }
    }
    let title = score.title.clone();
    let mut work = Work { number: None, title: None, movement_title: None, subtitles: Vec::new(), version: None };
    if truthy(&score.subtitle) {
        work.subtitles.push(score.subtitle.clone().unwrap_or_default());
        work.subtitles.extend(score.subtitles_more.iter().cloned());
    }
    let key = if score.minor {
        Key { fifths: score.fifths as f64, mode: Some("minor".into()), tonic_degree: Some("6".into()), ..Default::default() }
    } else {
        Key { fifths: score.fifths as f64, ..Default::default() }
    };
    let mut song = Song {
        work,
        identification: None,
        credits: None,
        key: Some(key),
        time: Some(Time { beats: score.beats as f64, beat_type: score.beat_type as f64, symbol: None, parenthesized: None }),
        extra_times: None,
        time_note: None,
        tempos: None,
        tempo_beat: None,
        defaults: None,
        part_groups: None,
        parts,
        marks,
        play_order: None,
        sing_order: None,
        layouts: None,
        section_order: None,
        section_marks: None,
        style: None,
        page_text: None,
        remarks: None,
        muse_directives: None,
        meta: None,
        source: None,
        oid: Oid::NONE,
    };
    if let Some(t) = &title {
        song.work.title = Some(t.clone());
    }
    // 页眉说明与对不上音的谱后附段（照印的行，123 读写同为 `W:` / `N:` 落的 remarks）
    let remarks: Vec<String> = score.header_notes.iter().chain(&score.post_lyrics).cloned().collect();
    if !remarks.is_empty() {
        song.remarks = Some(remarks);
    }
    if truthy(&score.number) {
        song.work.number = score.number.clone();
    }
    // 印在标题右侧的曲号（新编赞美诗·四声部「圣哉三一歌 … 1」）：文本谱写 `XR:`、123 另记 `I:indexright`；
    // 左侧的不用另记（写出端缺省就写 `XL:`）。
    if truthy(&score.number) && score.number_side == Some("right") {
        song.page_text = Some(PageText { index_right: score.number.clone(), ..empty_page_text() });
    }
    // 印在标题左边的署名记左上（文本谱 `TL:`）：诗歌本的 `Z:` 排在标题下右对齐，记成署名就挪了位置
    if !score.credits_top_left.is_empty() {
        song.page_text.get_or_insert_with(empty_page_text).top_left.extend(score.credits_top_left.iter().cloned());
    }
    // 谱后的注（「注：…」）记页脚左（文本谱 `BL:`）
    if !score.footnotes.is_empty() {
        song.page_text.get_or_insert_with(empty_page_text).bottom_left.extend(score.footnotes.iter().cloned());
    }
    // 页眉并排印着的其余拍号（混合拍）与拍号后面那段说明文字（「混合拍」）
    if score.meters.len() > 1 {
        song.extra_times = Some(score.meters[1..].iter().map(|m| Time { beats: m.beats as f64, beat_type: m.beat_type as f64, symbol: None, parenthesized: None }).collect());
    }
    if truthy(&score.meter_note) {
        song.time_note = score.meter_note.clone();
    }
    // 著作者整行（作词：…/作曲：…）：按行首标签定类型，没有标签的记 composer
    let title_trim = title.as_deref().map(str::trim);
    let creators: Vec<Creator> = score
        .credits
        .iter()
        .map(|c| c.replace('\n', " ").trim().to_owned())
        .filter(|c| !c.is_empty() && Some(c.as_str()) != title_trim)
        .map(|c| creator_of(&c))
        .collect();
    if !creators.is_empty() {
        song.identification = Some(Identification { creators, rights: None, software: None });
    }
    if let Some(t) = score.tempo.filter(|&t| t != 0) {
        song.tempos = Some(vec![Tempo::Bpm(t as f64)]);
        if let Some(b) = score.tempo_beat {
            song.tempo_beat = Some(Ratio { num: b.num as f64, den: b.den as f64 });
        }
    }
    let mut doc = empty_doc(SourceFormat::Omr);
    doc.songs.push(song);
    Built { doc, num_of }
}

/// 一个声部的谱行（`rows` 是行下标）→ 小节序列。`marks` 由各声部共用（元素 id 全局唯一）。
fn measures_of_rows(
    rows: &[usize],
    score: &RecognizedScore,
    flat: &Flat,
    ids: &mut IdGen,
    marks: &mut Vec<Mark>,
    num_of: &mut Vec<(ElementId, usize)>,
    group_of: Option<&HashMap<usize, u32>>,
) -> Vec<Measure> {
    // 遵照图片小节线：行末无小节线时（开口收尾），本行末小节与下一行行首小节实为同一跨行小节，合并，
    // 不在换行处凭空补小节线。行末有小节线（如终止线）才各自成节。
    // 记录每个 row 在 all 中「干净起始」的小节下标（>0 才记），供换行（`Print.new_system`）恢复原图分行。
    // 若本行首小节被并入上一行的跨行小节（open-tail），则视觉行首落在小节内部，无法在小节边界干净断行 → 不记。
    let mut all: Vec<Vec<usize>> = Vec::new();
    let mut row_start = HashSet::new();
    let mut group_at: HashMap<usize, u32> = HashMap::new(); // 行首小节下标 → 组号（只在局部多声部时给，见 recognized_to_doc）
    let mut end_style = HashSet::new(); // 右边界是终止线（‖）的小节
    let mut thin_end = HashSet::new(); // 其中只按位置认的（两根没分出粗细）
    let mut double = HashSet::new(); // 右边界是复纵线（细细双线 ‖）的小节
    let mut silent = HashSet::new(); // 声部整小节不唱（写整小节隐形休止）
    let mut hidden = HashSet::new(); // 右边界是不可见小节线（行末开口、下一行行首却带 segno，见下）
    // 行首段号（`1.`）挂到该行每段第一个有词的音符上（`Lyric.verse_label`）
    let mut label_of: HashMap<(usize, usize), String> = HashMap::new();
    let mut break_after = HashSet::new();
    let mut open_tail = false;
    let n_at = |i: usize| flat.nums[i];
    for &ri in rows {
        let row = &score.rows[ri];
        let base = flat.row_base[ri];
        for (v, label) in row.lyric_labels.iter().enumerate() {
            let first = row.nums.iter().position(|n| n.lyrics.get(v).is_some_and(|t| !t.is_empty()));
            if let (false, Some(k)) = (label.is_empty(), first) {
                label_of.insert((base + k, v), label.clone());
            }
        }
        let mut ms = measures_of_row(row, base);
        if ms.is_empty() {
            continue;
        }
        let mark_double = |m: &RowMeasure, idx: usize, double: &mut HashSet<usize>, end_style: &mut HashSet<usize>| {
            if let Some(x) = m.right_x {
                if row.double_bar_xs.contains(&x) {
                    double.insert(idx);
                }
                if row.end_bar_xs.contains(&x) {
                    end_style.insert(idx);
                }
            }
        };
        let first_num = ms[0].notes.first().map(|&i| n_at(i));
        // 行首就是 `‖:`（上一行末开口）：那道反复线就是本行首小节的左线，不并进上一行——
        // 青年诗歌 13《爱使我们相聚一起》`… 2|1 - - $ ‖:3̲ 4̲|5 …`，并了反复线就落到 `1 - -` 前面
        // segno 印在行首、上一行末开口（青年诗歌 60《经历基督作牧人》`… | 1 $ 𝄋 3·♯2̳ | …`）同理：segno 只能挂小节线，
        // 并进跨行小节就落到上一行的 `1` 前面、D.S. 跳回来多唱一个音。上一行末收一道不可见线 `[|]`，segno 挂本行首小节左线
        let segno_head = open_tail && !all.is_empty() && first_num.is_some_and(|n| n.segno);
        if segno_head {
            hidden.insert(all.len() - 1);
        }
        if open_tail && !all.is_empty() && !first_num.is_some_and(|n| n.repeat_forward) && !segno_head {
            // 跨行小节：原图换行落在小节中间，记在上一行最后一个音上（`Chord.line_break_after`），写出时原位断行
            if let Some(&last) = all.last().and_then(|p| p.last()) {
                break_after.insert(last);
            }
            let first = ms.remove(0);
            let li = all.len() - 1;
            all[li].extend(first.notes.iter().copied());
            mark_double(&first, li, &mut double, &mut end_style);
        } else {
            if !all.is_empty() {
                row_start.insert(all.len());
            }
            if let Some(&g) = group_of.and_then(|m| m.get(&ri)) {
                group_at.insert(all.len(), g);
            }
        }
        for m in ms {
            all.push(m.notes.clone());
            mark_double(&m, all.len() - 1, &mut double, &mut end_style);
            if m.silent {
                silent.insert(all.len() - 1);
            }
        }
        if row.final_barline == Some("end") {
            end_style.insert(all.len() - 1);
            if row.final_barline_thin {
                thin_end.insert(all.len() - 1);
            }
        }
        open_tail = !row_ends_closed(row);
    }

    // 弧线配对要按**谱面顺序**在全曲范围内做（跨小节的弧才配得上）。
    let order: Vec<usize> = all.iter().flatten().copied().collect();
    let arcs = pair_arcs(&order, flat, score.fifths as f64);
    let mut open_slurs: HashMap<u32, ElementId> = HashMap::new(); // slur number → 起点元素 id
    let mut open_ties: Vec<ElementId> = Vec::new();
    let mut tuplet_start: Option<ElementId> = None;

    let (mut cur_beats, mut cur_beat_type) = (score.beats, score.beat_type);
    let count = all.len();
    let mut out = Vec::with_capacity(count);
    for (idx, notes) in all.iter().enumerate() {
        let mut m = Measure { number: (idx + 1).to_string(), ..Default::default() };
        if row_start.contains(&idx) {
            m.print = Some(Print { new_system: Some(true), ..Default::default() });
        }
        // 声部在后面的组才露面（局部多声部的第 2 声部）：它的首小节在全曲是换行处
        if let Some(&g) = group_at.get(&idx) {
            let p = m.print.get_or_insert_with(Default::default);
            if g > 0 {
                p.new_system = Some(true);
            }
            p.system = Some(g as f64);
        }
        // 曲中转拍号：识别时锚在该小节头一个音符上（JpNum.time_change），提升为本小节的 `attrs.time`。
        if let Some(change) = notes.iter().find_map(|&i| n_at(i).time_change.as_ref()) {
            if idx > 0 && (change.beats != cur_beats || change.beat_type != cur_beat_type) {
                cur_beats = change.beats;
                cur_beat_type = change.beat_type;
                m.attrs = Some(MeasureAttrs { time: Some(Time { beats: cur_beats as f64, beat_type: cur_beat_type as f64, symbol: None, parenthesized: None }), ..Default::default() });
            }
        }
        if silent.contains(&idx) {
            for _ in 0..cur_beats {
                let mut ch = rest_chord(ids.next(), Q * 4.0 / cur_beat_type as f64);
                ch.print_object = Some(false);
                m.elements.push(Element::Chord(ch));
            }
        }

        for &i in notes {
            let n = n_at(i);
            // 倚音：主音符左上角的小号数字，不占拍位，排在它修饰的那个音符**之前**。
            // 简谱的小音符一律带斜杠符干（acciaccatura）。
            for g in &n.grace {
                let mut ch = new_chord(ids.next(), Duration { divisions: 0.0, kind: grace_type(g.div), dots: 0.0, time_mod: None });
                ch.notes.push(Note { degree: Some(Degree { number: g.digit as f64, octave_shift: g.octave as f64, accidental: None }), ..Default::default() });
                ch.grace = Some(GraceInfo { slash: Some(true), ..Default::default() });
                m.elements.push(Element::Chord(ch));
            }

            let rest = n.digit == 0;
            // 简谱的长休止写成几个 0，不写增时线
            let sustain_count = if rest { 0 } else { n.augment as usize };
            let mut ch = new_chord(ids.next(), duration_123(n.div, u32::from(n.dot > 0), sustain_count));
            num_of.push((ch.id, i));
            if rest {
                ch.rest = Some(RestInfo::default());
            } else if n.digit == RHYTHM_DIGIT {
                ch.rhythm = Some(true);
            } else {
                // 临时升降号只记谱面上印的；按简谱规矩在小节内延续由读端（`jianpu::AccidentalCarry`）管。
                let acc = n.accidental.map(Accidental::parse);
                ch.notes.push(Note { degree: Some(Degree { number: n.digit as f64, octave_shift: n.octave as f64, accidental: acc.clone() }), accidental: acc, ..Default::default() });
            }
            if n.div > 0 {
                ch.beams = Some(vec![BeamVal::Continue; n.div as usize]);
            }
            if sustain_count > 0 {
                ch.sustains = Some((0..sustain_count).map(|_| new_sustain(ids.next())).collect());
            }

            // 多连音：组里每个音符都带同一份比例，首尾另记一条 `tuplet` Mark。时值记名义值（同 123 解析端）。
            if let Some(t) = &n.tuplet {
                ch.duration.time_mod = Some(TimeMod { actual: t.actual as f64, normal: t.normal as f64, normal_type: None });
                if t.start {
                    tuplet_start = Some(ch.id);
                }
                if t.stop {
                    if let Some(s) = tuplet_start.take() {
                        let mut mk = Mark::new(MarkType::Tuplet, s, ch.id);
                        mk.tuplet_actual = Some(t.actual as f64);
                        mk.tuplet_normal = Some(t.normal as f64);
                        marks.push(mk);
                    }
                }
            }

            place_chords(n, &mut ch);

            let mut notations = Notations::default();
            let mut any = false;
            if n.fermata {
                notations.fermata = Some(true);
                any = true;
            }
            // 顿音 ▼ = staccato（与文本谱 `&dy` 同一口径）、重音 > = accent（`&zy`）；上波音 ∿ = inverted-mordent（123 写回 `!sby!`），
            // 带竖杠的下波音 = mordent（`!xby!`）。
            let mut arts: Option<Vec<String>> = n.articulation.map(|a| vec![a.to_owned()]);
            let is_word = |x: &String| x.starts_with("cresc") || x.starts_with("dim");
            let dyn_marks: Vec<String> = n.dynamics.iter().filter(|x| !is_word(x)).cloned().collect();
            let dyn_words: Vec<String> = n.dynamics.iter().filter(|x| is_word(x)).cloned().collect();
            if !dyn_marks.is_empty() {
                arts.get_or_insert_with(Vec::new).extend(dyn_marks);
            }
            if n.fall {
                arts.get_or_insert_with(Vec::new).push("xhy".into());
            }
            if arts.is_some() {
                notations.articulations = arts;
                any = true;
            }
            match n.ornament {
                Some("upper-mordent") => notations.ornaments = Some(vec!["inverted-mordent".into()]),
                Some("lower-mordent") => notations.ornaments = Some(vec!["mordent".into()]),
                _ => {}
            }
            if any || notations.ornaments.is_some() {
                ch.notations = Some(notations);
            }

            // 段落标记（Intro/Verse/Chorus/Coda…，谱面上多印成方框）→ 段落词
            if truthy(&n.section_mark) || !dyn_words.is_empty() {
                let words: Vec<&str> = n.section_mark.iter().map(String::as_str).chain(dyn_words.iter().map(String::as_str)).filter(|s| !s.is_empty()).collect();
                ch.section_word = Some(words.join(" "));
            }

            // 歌词：按 verse 索引，逐字挂音符
            if !n.lyrics.is_empty() {
                let lyrics: Vec<Lyric> = n
                    .lyrics
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| !t.is_empty())
                    .map(|(v, text)| Lyric {
                        number: (v + 1) as f64,
                        text: text.clone(),
                        syllabic: Some(Syllabic::Single),
                        verse_label: label_of.get(&(i, v)).cloned(),
                        ..Default::default()
                    })
                    .collect();
                if !lyrics.is_empty() {
                    ch.lyrics = Some(lyrics);
                }
            }

            // 弧线：slur 按 number 配对，tie 两端音高已在 pair_arcs 里验过（延音线同时记在音上与 Mark 上，同 xmlproject 的口径）
            if let Some((starts, stops)) = arcs.slur.get(&i) {
                for k in stops {
                    if let Some(start) = open_slurs.remove(k) {
                        let mut mk = Mark::new(MarkType::Slur, start, ch.id);
                        mk.number = Some(*k as f64);
                        marks.push(mk);
                    }
                }
                for &k in starts {
                    open_slurs.insert(k, ch.id);
                }
            }
            if let Some(&(t_start, t_stop)) = arcs.tie.get(&i) {
                let id = ch.id;
                if let Some(note) = ch.notes.first_mut() {
                    if t_stop {
                        if let Some(start) = open_ties.pop() {
                            marks.push(Mark::new(MarkType::Tied, start, id));
                        }
                        note.tie.get_or_insert_with(Default::default).stop = Some(true);
                    }
                    if t_start {
                        open_ties.push(id);
                        note.tie.get_or_insert_with(Default::default).start = Some(true);
                    }
                }
            }

            m.elements.push(Element::Chord(ch));
            // 长休止：增时线换成几个一拍的 0
            if rest {
                for _ in 0..n.augment {
                    m.elements.push(Element::Chord(rest_chord(ids.next(), Q)));
                }
            }
            if break_after.contains(&i) {
                if let Some(Element::Chord(last)) = m.elements.last_mut() {
                    last.line_break_after = Some(BreakKind::System);
                }
            }
        }

        // 反复与一/二房：识别阶段锚到边界相邻音符，这里提升成小节左右线。
        let mut barlines: Vec<Barline> = Vec::new();
        let nums = || notes.iter().map(|&i| n_at(i));
        let ending_start = nums().find_map(|n| n.ending_start.clone());
        let repeat_forward = nums().any(|n| n.repeat_forward);
        // segno 是跳转的**目标**（D.S. 跳回来落在这条线上），故挂左线；图上它印在本小节起头的上方。
        let segno = nums().any(|n| n.segno);
        if ending_start.is_some() || repeat_forward || segno {
            let mut b = Barline::at(BarLocation::Left);
            if repeat_forward {
                b.style = Some(BarStyle::HeavyLight);
                b.repeat = Some(RepeatDir::Forward);
            }
            if let Some(t) = ending_start {
                b.ending = Some(ending_of(&t, EndingType::Start));
            }
            if segno {
                b.ornaments = Some(vec![SourceOrnament { name: "hs".into(), level: 0.0, below: None }]);
            }
            barlines.push(b);
        }
        let ending_stop = nums().rev().find_map(|n| n.ending_stop.clone());
        let repeat_backward = nums().any(|n| n.repeat_backward);
        let mut jumps: Vec<&str> = Vec::new();
        for j in nums().flat_map(|n| n.jump_marks.iter()) {
            if !jumps.contains(&j.as_str()) {
                jumps.push(j);
            }
        }
        let jumps_below: HashSet<&str> = nums().flat_map(|n| n.jump_below.iter().map(String::as_str)).collect();
        let jump = !jumps.is_empty();
        // 普通小节线也要显式写出：`.jpwabc` 写出端按右线出 `|`，没有就把相邻小节并成一个。
        // 曲末那小节图上没收线的不补（遵图片小节线）。
        let closed = idx + 1 < count || !open_tail;
        if ending_stop.is_some() || repeat_backward || end_style.contains(&idx) || jump || closed {
            let mut b = Barline::at(BarLocation::Right);
            let dc_ds = jumps.iter().any(|&j| j == "D.C." || j == "D.S.");
            // 反复线与终止线不叠（终止线由 StaffRow.final_barline 另管）
            if repeat_backward {
                b.style = Some(BarStyle::LightHeavy);
                b.repeat = Some(RepeatDir::Backward);
            }
            // 按位置认的终止线又挂着 D.C./D.S.：曲终在别处（Fine），这道是复纵线；Fine 也印在这里的，曲终就在此，仍是终止线
            // 二房收在全曲末小节（青年诗歌 5《第一声呼求》`[2 … | 1̇ – – ‖`）：房尾不挡终止线
            else if (ending_stop.is_none() || idx + 1 == count) && end_style.contains(&idx) {
                b.style = Some(if thin_end.contains(&idx) && dc_ds && !jumps.contains(&"Fine") { BarStyle::LightLight } else { BarStyle::LightHeavy });
            }
            // 复纵线与房尾**可以同时出现**（76《天上有粮》一房末就是 `[1 … ||`，图上没画反复冒号），
            // 故不像终止线那样给 ending_stop 让位。
            // 下一小节以反复起始 `‖:` 开头：那对粗细线就是反复线本身（青年诗歌 5《第一声呼求》`5 ‖: 3̇`），不另记复纵线
            // 全曲末小节的细细双线同「末行行末两根并排」一个口径，是终止线：识别时末谱行之后还排着歌词凑成的伪行
            //（青年诗歌 79 末段英文「I' l l walk」的 l 读成小节线），那道 ‖ 就被当成了曲中的复纵线
            else if double.contains(&idx) && idx + 1 == count && !dc_ds {
                b.style = Some(BarStyle::LightHeavy);
            } else if double.contains(&idx) && !all.get(idx + 1).is_some_and(|nx| nx.iter().any(|&k| n_at(k).repeat_forward)) {
                b.style = Some(BarStyle::LightLight);
            } else if hidden.contains(&idx) {
                b.style = Some(BarStyle::NoStyle);
            } else if closed {
                b.style = Some(BarStyle::Regular);
            }
            if let Some(t) = ending_stop {
                b.ending = Some(ending_of(&t, EndingType::Stop));
            }
            // 跳转记号（D.C./D.S./Fine/To Coda）：识别时锚在本小节某音符上，记在小节末
            for j in &jumps {
                match jump_ornament(j) {
                    Some(name) => b.ornaments.get_or_insert_with(Vec::new).push(SourceOrnament { name: name.into(), level: 0.0, below: jumps_below.contains(j).then_some(true) }),
                    None => b.annotation = Some(match b.annotation.take() {
                        Some(a) => format!("{a} {j}"),
                        None => (*j).to_owned(),
                    }),
                }
            }
            barlines.push(b);
        }
        if !barlines.is_empty() {
            m.barlines = Some(barlines);
        }
        out.push(m);
    }
    out
}

/// 房号原文 "1,2,3,5" → `Ending`
fn ending_of(text: &str, kind: EndingType) -> Ending {
    let numbers = text
        .split(|c: char| c == ',' || c == '，' || c == '.' || js::is_space(c))
        .map(js::number)
        .filter(|v| v.is_finite() && *v > 0.0)
        .collect();
    Ending::new(numbers, kind, Some(text.to_owned()))
}
