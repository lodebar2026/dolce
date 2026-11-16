//! ABC 的临时记号（§4.2，同 `abcfamily/abcpitch.ts`）：音名 + 记号是**绝对**的，记号管到本小节末、只管同音名同八度。
//! 读：音名 + 面上的记号 → 实际音高（`resolve_abc_pitches`），度数再由 `assign_degrees` 从音高推。

use dolce_base::js::num_to_string;
use dolce_model::edit::key_alter;
use dolce_model::jianpu::{acc_by_offset, assign_degrees, c_major, continues_measure, offset_by_acc};
use dolce_model::keyshift::key_fifths;
use dolce_model::{Accidental, Element, Key, Measure, Pitch, Song};
use std::collections::HashMap;

/// 一小节里 ABC 记号的延续状态：同音名同八度 → 实际升降（`None` = TS 存进去的 undefined）
pub struct AbcCarry {
    alters: HashMap<String, Option<f64>>,
    fifths: f64,
}

fn slot(p: &Pitch) -> String {
    format!("{}{}", p.step.as_str(), num_to_string(p.octave))
}

impl AbcCarry {
    pub fn new(fifths: f64) -> AbcCarry {
        AbcCarry { alters: HashMap::new(), fifths }
    }

    fn expected(&self, p: &Pitch) -> f64 {
        self.alters.get(&slot(p)).copied().flatten().unwrap_or_else(|| key_alter(p.step.as_str(), self.fifths))
    }

    /// 读：面上的记号（没有就沿用本小节前面的，再没有就是调号）→ 实际升降（认不得的记号名给 `None`）
    pub fn sounding(&mut self, p: &Pitch, written: Option<&Accidental>) -> Option<f64> {
        let Some(w) = written else { return Some(self.expected(p)) };
        let alter = offset_by_acc(w);
        self.alters.insert(slot(p), alter);
        alter
    }

    /// 写：实际音高 → 面上要印的记号（与调号、本小节前面的都相同就不印）
    pub fn written(&mut self, p: &Pitch) -> Option<Accidental> {
        if p.alter == self.expected(p) {
            return None;
        }
        self.alters.insert(slot(p), Some(p.alter));
        acc_by_offset(p.alter)
    }
}

/// 逐小节走一首歌，每小节（拆开的后半接着前半）给一份新的延续状态
pub fn each_measure(song: &mut Song, mut f: impl FnMut(&mut Measure, &Key, bool)) {
    let song_key = song.key.clone().unwrap_or_else(c_major);
    for part in song.parts.iter_mut() {
        let mut key = song_key.clone();
        for mi in 0..part.measures.len() {
            if let Some(k) = part.measures[mi].attrs.as_ref().and_then(|a| a.key.clone()) {
                key = k;
            }
            let fresh = !continues_measure(if mi > 0 { Some(&part.measures[mi - 1]) } else { None }, &part.measures[mi]);
            f(&mut part.measures[mi], &key, fresh);
        }
    }
}

/// ABC 读入：把音名 + 面上记号换成实际音高，再按简谱规则推度数
pub fn resolve_abc_pitches(song: &mut Song) {
    let mut carry = AbcCarry::new(0.0);
    each_measure(song, |m, key, fresh| {
        if fresh {
            carry = AbcCarry::new(key_fifths(key));
        }
        for el in m.elements.iter_mut() {
            let Element::Chord(c) = el else { continue };
            for n in c.notes.iter_mut() {
                let Some(p) = &n.pitch else { continue };
                let alter = carry.sounding(p, n.accidental.as_ref());
                // 认不得的记号名：TS 得到 alter = undefined（JSON 里不写）；这里记 NaN 不可序列化，按 0 记（ABC 词法只产生五种记号，到不了）
                n.pitch.as_mut().unwrap().alter = alter.unwrap_or(0.0);
            }
        }
    });
    let key = song.key.clone().unwrap_or_else(c_major);
    for part in song.parts.iter_mut() {
        assign_degrees(part, &key);
    }
}
