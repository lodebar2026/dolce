//! 矢量页的框架与字形身份（排查）：`cargo run --release -p dolce-omr-staff --example vecframe -- 文件.pdf [页号]`
use dolce_omr_sheet::prims::VEC_SCALE;
use dolce_omr_sheet::shapes::guess_by_code;
use dolce_omr_source::vector::VecPage;
use dolce_omr_source::{ContentOpts, PdfDoc};
use dolce_omr_staff::vector::{frame_vector, glyphs};
use std::collections::BTreeMap;

fn main() -> Result<(), String> {
    let a: Vec<String> = std::env::args().collect();
    let doc = PdfDoc::open(std::fs::read(&a[1]).map_err(|e| e.to_string())?)?;
    let only: Option<usize> = a.get(2).and_then(|s| s.parse().ok());
    for pn in 0..doc.page_count() {
        if only.is_some_and(|p| p != pn) {
            continue;
        }
        let pc = doc.content(pn, ContentOpts::default())?;
        let vp = VecPage::build(&pc, VEC_SCALE, (0.0, 0.0));
        println!("== p{pn} 对象 {} 线段 {}", vp.objs.len(), vp.lines.len());
        if let Some(f) = frame_vector(&vp) {
            let l = &f.layout;
            println!("  谱表 {} 线距 {:.1} 线宽 {:.2} 系统 {:?}", l.staves.len(), l.unit.space, l.unit.thick, l.systems.iter().map(|s| s.staves.len()).collect::<Vec<_>>());
            println!("  各行小节线 {:?}", l.bars.iter().map(|b| b.len()).collect::<Vec<_>>());
            if let Ok(r) = std::env::var("BARROW") { let r: usize = r.parse().unwrap(); println!("  行{r} 小节线 {:?} 谱表 {:?} 左右 {:.0}~{:.0}", l.bars[r].iter().map(|b| (b.x.round(), b.weak, b.src)).collect::<Vec<_>>(), l.staves[r].ys, l.staves[r].left, l.staves[r].right); println!("  竖段 {:?}", f.segs.iter().filter(|v| v.cx() > 1500.0 && v.cx() < 1700.0 && v.y0 < 400).collect::<Vec<_>>()); }
        } else {
            println!("  没有谱表");
        }
        if std::env::var("OMR_VEC_DEBUG").is_ok() {
            if let Some(p) = dolce_omr_staff::vector::recognize_vector(&pc, None) {
                if let Some(r) = std::env::var("ROW").ok().and_then(|v| v.parse::<usize>().ok()) {
                    for c in &p.notes[r].chords {
                        println!("    和弦 x{:.0} 头{:?} 干{:?} 尾{} 杠{} 点{}", c.x, c.heads.iter().map(|h| (h.pos, h.kind)).collect::<Vec<_>>(), c.stem.map(|s| (s.x, s.top, s.bottom, s.up)), c.tails, c.beamed, c.dots);
                    }
                }
                for (i, a) in p.attrs.iter().enumerate() {
                    println!("  行{i} 谱号{:?} 调{:?} 拍{:?} 行首右缘{:.0} 切换{:?}", a.clef.map(|c| c.sign), a.key.map(|k| k.fifths), a.time.map(|t| (t.beats, t.beat_type)), a.lead_end, a.changes.iter().map(|c| (c.x.round(), c.attrs.key.map(|k| k.fifths), c.attrs.time.map(|t| t.beats))).collect::<Vec<_>>());
                }
            }
        }
        let syms = glyphs::music_chars(&vp);
        let mut hist: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
        let mut differ = 0;
        for s in &syms {
            let e = hist.entry(s.name).or_default();
            e.0 += 1;
            if s.dist < dolce_omr_sheet::shapes::SIG_MAX {
                e.1 += 1;
            }
            let c = vp.char_of(&vp.objs[s.obj as usize]).unwrap();
            if let Some(code) = glyphs::family_of(&vp, s).and_then(|f| guess_by_code(f, c.unicode)) {
                if code != s.name {
                    differ += 1;
                    if differ <= 8 {
                        println!("  码位 {} U+{:04X} → {code}，字典 {}（{}）", c.font, c.unicode, s.name, s.dist);
                    }
                }
            } else if s.name.is_empty() {
                println!("  认不出 {} U+{:04X} {:.2}×{:.2}em", c.font, c.unicode, c.bbox.w / c.size_scaled, c.bbox.h / c.size_scaled);
            }
        }
        println!("  音乐字 {}，码位与字典不一 {differ}：{:?}", syms.len(), hist);
    }
    Ok(())
}
