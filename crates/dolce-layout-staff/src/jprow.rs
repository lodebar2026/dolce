//! 混排简谱层一个数字的竖向落点（主音与倚音），画（`overlay`）与量高（`model::part_calc_mixed_staff_y`）共用（照 `jprow.ts`）。
//! 坐标系是简谱层自己的：谱表顶 y = 0、数字基线在 `mixFont.size` 处。

use dolce_base::js;
use dolce_engrave::stack::{stack_bottom, stack_top, StackStyle};

use crate::model::{ChordId, NoteId, PmId, StaffLayout};

/// 简谱层一个数字的竖向落点：基线、缩放、「1」的墨迹顶底，以及它那一摞的取尺（engrave/stack）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JpRow {
    pub y: f64,
    pub scale: f64,
    pub ink_top: f64,
    pub ink_bottom: f64,
    pub st: StackStyle,
}

/// `melodyNote`：第一个旋律音，没有就取第一个音（和弦没有音 TS 返回 undefined 后续抛错，这里 panic）。
pub fn melody_note(sl: &StaffLayout, c: ChordId) -> NoteId {
    let ch = &sl[c];
    ch.notes.iter().copied().find(|&n| sl[n].jp_melody).unwrap_or_else(|| ch.notes[0])
}

/// 主音这一行：数字基线在 `字号` 处（谱表顶 y = 0），叠层的空 = `stackGap` × 数字墨迹高。
pub fn main_row(sl: &StaffLayout) -> JpRow {
    let font = sl.mix_font();
    let b = font.char_bound(sl.mc, "1");
    let d = font.char_bound(sl.mc, ".");
    let y = font.size;
    JpRow {
        y,
        scale: 1.0,
        ink_top: y + b.top,
        ink_bottom: y + b.bottom,
        st: StackStyle { gap: sl.options.stack_gap * b.height(), dot_radius: (d.bottom - d.top) / 2.0, beam_width: sl.options.line_widths.jp_beam },
    }
}

/// 倚音这一行：整体按 `jpGraceScale` 缩小（点、线、空一起缩），**整块**（数字、减时线、低音点；钩子不算）
/// 的墨迹底离它所倚的主音那一摞的顶一道空。同一串倚音取最深的那颗定块高。
pub fn grace_row(sl: &StaffLayout, md: PmId, ch: ChordId) -> JpRow {
    let main = main_row(sl);
    let sc = sl.options.jp_grace_scale;
    let st = StackStyle { gap: main.st.gap * sc, dot_radius: main.st.dot_radius * sc, beam_width: main.st.beam_width * sc };
    let h = (main.ink_bottom - main.ink_top) * sc;
    let chords = &sl[md].chords;
    // indexOf 找不到是 -1：i0 = -1 不进循环，i1 从 -1 起 chords[-1] 是 undefined → 停在 -1，slice(-1, -1) 为空、host 为 undefined
    let idx = chords.iter().position(|&c| c == ch);
    let mut below: f64 = 0.0;
    let mut host: Option<ChordId> = None;
    if let Some(idx) = idx {
        let mut i0 = idx;
        while i0 > 0 && sl[chords[i0 - 1]].grace() {
            i0 -= 1;
        }
        let mut i1 = idx;
        while i1 < chords.len() && sl[chords[i1]].grace() {
            i1 += 1;
        }
        for &g in &chords[i0..i1] {
            below = js::max(below, stack_bottom(0.0, sl[g].jp_beam_count(), js::max(0.0, -sl.note_octave_jp(melody_note(sl, g))), &st));
        }
        host = chords.get(i1).copied();
    }
    let main_top = stack_top(main.ink_top, host.map_or(0.0, |h| sl.note_octave_jp(melody_note(sl, h))), &main.st);
    let ink_bottom = main_top - main.st.gap - below;
    let b = sl.mix_font().char_bound(sl.mc, "1");
    JpRow { y: ink_bottom - b.bottom * sc, scale: sc, ink_top: ink_bottom - h, ink_bottom, st }
}

/// 一颗倚音连同它的高音点的墨迹顶（简谱层坐标）。
pub fn grace_block_top(sl: &StaffLayout, md: PmId, ch: ChordId) -> f64 {
    let row = grace_row(sl, md, ch);
    stack_top(row.ink_top, js::max(0.0, sl.note_octave_jp(melody_note(sl, ch))), &row.st)
}
