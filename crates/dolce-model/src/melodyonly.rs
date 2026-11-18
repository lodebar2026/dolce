//! 只留旋律（照 `src/model/melodyonly.ts`）：歌本里「只印主旋律」的曲目（清单 `meta["layout.melody-only"]`）与成书读谱都只留第一个声部。
//!
//! 第二步（读完整条后删非旋律音）在混排引擎里（`MixedOptions.melodyOnly`），不在这里。

use crate::doc::{ElementId, Song};
use std::collections::HashSet;

/// 只留第一个声部（P1）。挂在被删声部元素上的记号一并删掉，免得端点悬空。就地改。
pub fn keep_first_part(song: &mut Song) {
    if song.parts.is_empty() {
        return;
    }
    song.parts.truncate(1);
    let pid = song.parts[0].id.clone();
    if let Some(gs) = song.part_groups.as_mut() {
        gs.retain(|g| g.parts.iter().all(|p| *p == pid));
    }
    let kept: HashSet<ElementId> = song.parts[0].measures.iter().flat_map(|m| m.elements.iter().map(|e| e.id())).collect();
    song.marks.retain(|mk| kept.contains(&mk.start) && kept.contains(&mk.end));
}
