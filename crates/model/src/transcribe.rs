//! 转记（同 `src/model/transcribe.ts`）：实际音高不动，只把全曲统一到目标首调，并按指定规则重算唱名与升降号。

use crate::doc::*;
use crate::edit::{key_alter, midi_of_pitch, respell_measure, EditHooks};
use crate::jianpu::{assign_degrees, continues_measure, key_spelling, AccidentalCarry};
use crate::keyshift::{key_fifths, song_fifths};
use crate::base::js::NumKey;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 临时半音的拼写：`keep` 照原谱的方向，`key` 按目标调号（降号调写降号，升号调与 C 调写升号），或统一升号、降号。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptionSpelling {
    Keep,
    Key,
    Sharp,
    Flat,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOptions {
    /// 目标调号的五度圈位置（-7..7）；界面写作 `1=?`
    pub fifths: f64,
    pub spelling: TranscriptionSpelling,
    /// 每个临时升降音都写记号，不省略同小节内重复的记号
    #[serde(default)]
    pub repeat_accidentals: Option<bool>,
}

/// 简谱来源通常只有 degree：先按原调号把绝对音高补齐，后面换调号时才不会改变实际音高。返回各声部各小节的原调号。
fn fill_pitches(song: &mut Song) -> Vec<Vec<f64>> {
    let initial = Key { fifths: song_fifths(song), ..song.key.clone().unwrap_or_default() };
    let mut keys = vec![];
    for part in &mut song.parts {
        let mut per = vec![];
        let mut key = initial.clone();
        let mut clef_oct: HashMap<NumKey, f64> = HashMap::new();
        let mut carries: HashMap<NumKey, AccidentalCarry> = HashMap::new();
        for mi in 0..part.measures.len() {
            if let Some(k) = part.measures[mi].attrs.as_ref().and_then(|a| a.key.as_ref()) {
                key = Key { fifths: key_fifths(k), ..k.clone() };
            }
            per.push(key.fifths);
            for c in part.measures[mi].attrs.iter().flat_map(|a| a.clefs.iter().flatten()) {
                clef_oct.insert(NumKey::new(c.staff.unwrap_or(1.0)), c.octave_change.unwrap_or(0.0));
            }
            let prev = if mi > 0 { part.measures.get(mi - 1) } else { None };
            if !continues_measure(prev, &part.measures[mi]) {
                carries.clear();
            }
            for el in &mut part.measures[mi].elements {
                let Element::Chord(c) = el else { continue };
                let carry = carries.entry(NumKey::new(c.staff)).or_default();
                for note in &mut c.notes {
                    let Some(d) = note.degree.as_ref().filter(|d| d.number != 0.0) else { continue };
                    let mut pitch = carry.pitch(d, &key);
                    pitch.octave += clef_oct.get(&NumKey::new(c.staff)).copied().unwrap_or(0.0);
                    if note.pitch.is_none() {
                        note.pitch = Some(pitch);
                    }
                }
            }
        }
        keys.push(per);
    }
    keys
}

fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// 调外音往哪边拼（+1 升号、-1 降号）。`from` 是这个音在原调里的五度圈位置。
fn spell_sign(p: &Pitch, from: f64, to: f64, spelling: TranscriptionSpelling) -> f64 {
    match spelling {
        TranscriptionSpelling::Sharp => return 1.0,
        TranscriptionSpelling::Flat => return -1.0,
        TranscriptionSpelling::Keep => {
            // 原谱的方向：相对原调号升了还是降了
            let offset = p.alter - key_alter(p.step.as_str(), from);
            if offset != 0.0 {
                return sign(offset);
            }
            // 原来是调内音、换了调才成调外音：原调升号多写升号，降号多写降号
            if from != to {
                return sign(from - to);
            }
        }
        TranscriptionSpelling::Key => {}
    }
    let s = sign(to);
    if s == 0.0 || s.is_nan() {
        1.0
    } else {
        s
    }
}

/// 升降策略相对于目标调的唱名，而不是绝对音名的升降号。
fn spell_transcribed_midi(midi: f64, fifths: f64, sign: f64) -> Pitch {
    const STEPS: [Step; 7] = [Step::C, Step::D, Step::E, Step::F, Step::G, Step::A, Step::B];
    const SEMI: [f64; 7] = [0.0, 2.0, 4.0, 5.0, 7.0, 9.0, 11.0];
    for offset in [0.0, sign] {
        for (i, step) in STEPS.iter().enumerate() {
            let alter = crate::play::jppitch::key_alter(i as f64, fifths) + offset;
            if (SEMI[i] + alter + 12.0) % 12.0 != (midi % 12.0 + 12.0) % 12.0 {
                continue;
            }
            return Pitch { step: step.clone(), alter, octave: (midi - SEMI[i] - alter) / 12.0 - 1.0 };
        }
    }
    // 调内音 + 往一边挪半音盖住了全部 12 个音级，走不到这里
    unreachable!("拼不出 MIDI {midi}（调号 {fifths}）")
}

fn target_key(fifths: f64) -> Key {
    let mut key = Key { fifths, mode: Some("major".into()), tonic_degree: Some("1".into()), ..Default::default() };
    key.spelling = Some(key_spelling(&key, false));
    key
}

fn clear_later_keys(song: &mut Song, key: &Key) {
    song.key = Some(key.clone());
    for part in &mut song.parts {
        if let Some(first) = part.measures.first_mut() {
            // `{ ...first.attrs, key }`：新对象
            let mut a = first.attrs.clone().unwrap_or_default();
            a.oid = Oid::NONE;
            a.key = Some(key.clone());
            first.attrs = Some(a);
        }
        for (mi, m) in part.measures.iter_mut().enumerate() {
            if mi > 0 {
                if let Some(a) = m.attrs.as_mut().filter(|a| a.key.is_some()) {
                    a.key = None;
                    if a.is_empty() {
                        m.attrs = None;
                    }
                }
            }
            if let Some(later) = m.later_attrs.take() {
                let kept: Vec<LaterAttrs> = later
                    .into_iter()
                    .map(|mut x| {
                        x.attrs.key = None;
                        x
                    })
                    .filter(|x| !x.attrs.is_empty())
                    .collect();
                m.later_attrs = if kept.is_empty() { None } else { Some(kept) };
            }
        }
    }
}

/// 就地转记整份文档。所有歌曲、声部、声线、和弦音与倚音都处理；MIDI 音高保持不变。再次用同一选项执行是幂等的。返回转了几个音。
pub fn transcribe_score(doc: &mut ScoreDoc, options: &TranscriptionOptions, hooks: &mut dyn EditHooks) -> f64 {
    let fifths = crate::base::js::max(-7.0, crate::base::js::min(7.0, options.fifths.trunc()));
    let key = target_key(fifths);
    let mut notes = 0.0;
    for song in &mut doc.songs {
        let source_keys = fill_pitches(song);
        clear_later_keys(song, &key);
        for (pi, part) in song.parts.iter_mut().enumerate() {
            for (mi, measure) in part.measures.iter_mut().enumerate() {
                let from = source_keys[pi][mi];
                for el in &mut measure.elements {
                    let Element::Chord(c) = el else { continue };
                    let mut pitched = false;
                    for note in &mut c.notes {
                        let Some(p) = &note.pitch else { continue };
                        notes += 1.0;
                        pitched = true;
                        let s = spell_sign(p, from, fifths, options.spelling);
                        note.pitch = Some(spell_transcribed_midi(midi_of_pitch(p), fifths, s));
                    }
                    if pitched {
                        hooks.forget_stem(c);
                    }
                }
                respell_measure(measure, &key);
            }
            assign_degrees(part, &key);
            if options.repeat_accidentals == Some(true) {
                for measure in &mut part.measures {
                    for el in &mut measure.elements {
                        let Element::Chord(c) = el else { continue };
                        for note in &mut c.notes {
                            let Some(p) = &note.pitch else { continue };
                            let Some(acc) = AccidentalCarry::default().mark(p, &key) else { continue };
                            if acc == Accidental::Natural {
                                continue;
                            }
                            if let Some(d) = &mut note.degree {
                                d.accidental = Some(acc);
                            }
                            // 五线谱来源和写出使用绝对音名的记号，可能需要还原号
                            let alter = p.alter;
                            note.accidental = Some(if alter == 0.0 {
                                Accidental::Natural
                            } else if alter == 1.0 {
                                Accidental::Sharp
                            } else if alter == -1.0 {
                                Accidental::Flat
                            } else if alter == 2.0 {
                                Accidental::DoubleSharp
                            } else {
                                Accidental::DoubleFlat
                            });
                        }
                    }
                }
            }
        }
        hooks.forget_layout(song);
    }
    notes
}
