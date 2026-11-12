//! **核对 JSON**：编辑器对照视图、关联表、谱行菜单、可疑清单与换候选要的东西（交 web `omrrust/adapter.ts` 包成 `StaffReviewResult`）。
//! 字段名照 `staffomr/review.ts`：`pages[].staves[].lineYs / bars[].right / bars[].notes[].box`、`systems[]`（按页下标与页内谱行下标引用）、
//! `assignment`、`noteBoxes`、`markBoxes`、`stats`；另有 `doubts`（可疑清单）与 `alts`（各事件的落选候选，按事件第一个音的识别 id）。
//! 坐标一律是原图像素（`scale` 恒为 1）；页下标 0 起。
use super::*;
use dolce_omr_sheet::score::{Choice, SpanKind};
use serde_json::{json, Map, Value};

/// 核对 JSON 里的一个系统：第几页（0 起）、由页内哪几行谱组成（自上而下）。
pub type SystemRef = (usize, Vec<usize>);

impl Song {
    /// 照这次拼接的系统表与关联表写核对 JSON（不经会话时用）。
    pub fn review_json(&self) -> String {
        let systems: Vec<SystemRef> = self.systems.iter().map(|s| (s.page - 1, s.staves.clone())).collect();
        let assignment: Vec<Vec<Option<usize>>> = self.assignment.iter().map(|r| r.iter().map(|&v| Some(v)).collect()).collect();
        self.review_json_with(&systems, &assignment)
    }

    /// `systems` / `assignment`：会话的系统表与关联表（含不要的行，关联表里记 `null`）。两者形状一致，编辑器关联表照它显示、改了原样交回 `rebuild`。
    pub fn review_json_with(&self, systems: &[SystemRef], assignment: &[Vec<Option<usize>>]) -> String {
        let bx = |a: &SrcBox| -> Value { json!(BoxLrtb::from(a.rect)) };
        let mut notes = Map::new();
        let mut marks = Map::new();
        let mut alts = Map::new();
        let mut heads = 0usize;
        let mut mark = |rid: Option<Rid>, at: Option<SrcBox>, kind: &str| {
            if let (Some(r), Some(a)) = (rid, at) {
                marks.insert(r.to_string(), json!({ "page": a.page - 1, "box": bx(&a), "kind": kind }));
            }
        };
        for e in self.score.parts.iter().flat_map(|p| p.measures.iter()).flat_map(|m| m.events.iter()) {
            // 与写出端同一套取法（`Event::src_of`）：休止取第一个出处，和弦按音高逐个取——同音高叠着的两个头只有一个 id 写进 XML
            let written: Vec<Src> = if e.pitches.is_empty() { vec![e.src_of(None)] } else { e.pitches.iter().map(|p| e.src_of(Some(p))).collect() };
            for (k, src) in written.iter().enumerate() {
                let (Some(r), Some(a)) = (src.rid, src.at) else { continue };
                let p = e.pitches.get(k);
                let (step, octave, alter) = p.map_or(('C', 4, 0), |p| (p.step_name(), p.octave as i32, p.alter as i32));
                heads += p.is_some() as usize;
                notes.insert(r.to_string(), json!({ "page": a.page - 1, "box": bx(&a), "step": step, "octave": octave, "alter": alter, "rest": p.is_none() }));
            }
            if let (Some(r), false) = (written.first().and_then(|s| s.rid), e.alts.is_empty()) {
                let v: Vec<Value> = e
                    .alts
                    .iter()
                    .map(|a| match a.choice {
                        Choice::Duration { ntype, dots } => json!({ "kind": "duration", "type": ntype.xml(), "dots": dots, "cost": a.cost }),
                        Choice::Drop => json!({ "kind": "drop", "cost": a.cost }),
                    })
                    .collect();
                alts.insert(r.to_string(), Value::Array(v));
            }
            for l in &e.lyrics {
                mark(l.src.rid, l.src.at, "lyric");
            }
            for d in e.pre.iter().chain(&e.post) {
                match d.dir {
                    Dir::Words { .. } | Dir::Metronome { .. } => mark(d.src.rid, d.src.at, "words"),
                    Dir::Dynamics(_) => mark(d.src.rid, d.src.at, "dynamic"),
                    _ => {}
                }
            }
            for s in e.spans.iter().filter(|s| s.start) {
                mark(s.src.rid, s.src.at, if s.kind == SpanKind::Tied { "tied" } else { "slur" });
            }
        }
        let pages: Vec<Value> = self.pages.iter().map(|p| json!({ "pn": p.pn, "scale": 1.0, "staves": p.staves, "jianpu": p.jianpu })).collect();
        let systems: Vec<Value> = systems.iter().map(|(page, staves)| json!({ "page": page, "staves": staves })).collect();
        let out = json!({
            "version": 1,
            "pages": pages,
            "systems": systems,
            "assignment": assignment,
            "noteBoxes": notes,
            "markBoxes": marks,
            "doubts": self.doubts,
            "alts": alts,
            "stats": {
                "pages": self.pages.len(),
                "parts": self.score.parts.len(),
                "systems": self.systems.len(),
                "notes": heads,
                "bars": self.meter.checked,
                "full": self.meter.full_after,
            },
        });
        out.to_string()
    }
}
