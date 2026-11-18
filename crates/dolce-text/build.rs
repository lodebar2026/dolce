//! 编译期从仓库带的乐谱字体（`public/redist/Bravura.otf`、`BravuraText.otf`）抽出 Rust 自量要的表，写成 `$OUT_DIR/ownfonts.rs`：
//! 码点 → 字形号 / advance / 轮廓紧盒，`kern` 特性的字偶距，`ccmp` / `liga` 的连字序列与别的替换会碰到的字形。
//! 运行时不带字体文件、不做整形（见 `src/own.rs`）。

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::PathBuf;

use ttf_parser::gpos::{PairAdjustment, PositioningSubtable};
use ttf_parser::gsub::SubstitutionSubtable;
use ttf_parser::opentype_layout::LayoutTable;
use ttf_parser::{Face, GlyphId, Tag};

fn lookups_of(table: &LayoutTable, tags: &[&[u8; 4]]) -> BTreeSet<u16> {
    let mut out = BTreeSet::new();
    for f in table.features {
        if tags.iter().any(|t| f.tag == Tag::from_bytes(t)) {
            for i in f.lookup_indices {
                out.insert(i);
            }
        }
    }
    out
}

fn gen(out: &mut String, name: &str, face: &Face) {
    let upem = face.units_per_em();
    // 码点 → 字形号（取 Unicode 子表，先到先得）
    let mut cmap: BTreeMap<u32, u16> = BTreeMap::new();
    if let Some(c) = face.tables().cmap {
        for st in c.subtables {
            if !st.is_unicode() {
                continue;
            }
            st.codepoints(|cp| {
                if let Some(g) = st.glyph_index(cp) {
                    cmap.entry(cp).or_insert(g.0);
                }
            });
        }
    }
    let gids: BTreeSet<u16> = cmap.values().copied().collect();
    let mut rev: BTreeMap<u16, u32> = BTreeMap::new();
    for (&cp, &g) in &cmap {
        rev.entry(g).or_insert(cp);
    }

    // 字偶距：`kern` 特性各查找表；同一查找表里第一个盖住前字且有这一对的子表算数，各查找表相加
    let mut kern: BTreeMap<(u16, u16), i32> = BTreeMap::new();
    let mut odd = 0usize;
    if let Some(gpos) = face.tables().gpos {
        for li in lookups_of(&gpos, &[b"kern"]) {
            let Some(lookup) = gpos.lookups.get(li) else { continue };
            let mut seen: BTreeSet<(u16, u16)> = BTreeSet::new();
            for st in lookup.subtables.into_iter::<PositioningSubtable>() {
                let PositioningSubtable::Pair(pa) = st else { continue };
                for &g1 in &gids {
                    if !pa.coverage().contains(GlyphId(g1)) {
                        continue;
                    }
                    for &g2 in &gids {
                        if seen.contains(&(g1, g2)) {
                            continue;
                        }
                        let hit = match pa {
                            PairAdjustment::Format1 { coverage, sets } => {
                                coverage.get(GlyphId(g1)).and_then(|i| sets.get(i)).and_then(|s| s.get(GlyphId(g2)))
                            }
                            PairAdjustment::Format2 { classes, matrix, .. } => {
                                matrix.get((classes.0.get(GlyphId(g1)), classes.1.get(GlyphId(g2))))
                            }
                        };
                        let Some((v1, v2)) = hit else { continue };
                        seen.insert((g1, g2));
                        if v1.x_placement != 0 || v1.y_placement != 0 || v1.y_advance != 0 || v2.x_placement != 0 || v2.x_advance != 0 {
                            odd += 1;
                        }
                        if v1.x_advance != 0 {
                            *kern.entry((g1, g2)).or_insert(0) += v1.x_advance as i32;
                        }
                    }
                }
            }
        }
    }
    if odd > 0 {
        println!("cargo:warning={name}: {odd} 对字偶距带 x_advance 以外的调整，没收");
    }

    // 默认开的替换（ccmp、liga）：连字序列照收；别的替换碰到的字形记下，串里有就交宿主量
    let mut ligs: BTreeSet<Vec<u32>> = BTreeSet::new();
    let mut triggers: BTreeSet<u32> = BTreeSet::new();
    if let Some(gsub) = face.tables().gsub {
        for li in lookups_of(&gsub, &[b"ccmp", b"liga"]) {
            let Some(lookup) = gsub.lookups.get(li) else { continue };
            for st in lookup.subtables.into_iter::<SubstitutionSubtable>() {
                match st {
                    SubstitutionSubtable::Ligature(l) => {
                        for &g1 in &gids {
                            let Some(i) = l.coverage.get(GlyphId(g1)) else { continue };
                            let Some(set) = l.ligature_sets.get(i) else { continue };
                            for lig in set {
                                let mut seq = vec![rev[&g1]];
                                let mut ok = true;
                                for c in lig.components {
                                    match rev.get(&c.0) {
                                        Some(&cp) => seq.push(cp),
                                        None => ok = false,
                                    }
                                }
                                if ok {
                                    ligs.insert(seq);
                                }
                            }
                        }
                    }
                    other => {
                        let cov = match other {
                            SubstitutionSubtable::Single(s) => Some(s.coverage()),
                            SubstitutionSubtable::Multiple(s) => Some(s.coverage),
                            SubstitutionSubtable::Alternate(s) => Some(s.coverage),
                            SubstitutionSubtable::ReverseChainSingle(s) => Some(s.coverage),
                            _ => None,
                        };
                        match cov {
                            Some(cov) => {
                                for &g in &gids {
                                    if cov.contains(GlyphId(g)) {
                                        triggers.insert(rev[&g]);
                                    }
                                }
                            }
                            // 上下文替换：盖住谁不好说，整份字体都交宿主（真碰上再细分）
                            None => println!("cargo:warning={name}: 默认替换里有上下文查找表（{li}）"),
                        }
                    }
                }
            }
        }
    }

    let hhea_asc = face.tables().hhea.ascender;
    let hhea_desc = face.tables().hhea.descender;
    let (typo_asc, typo_desc, use_typo) = match face.tables().os2 {
        Some(o) => (o.typographic_ascender(), o.typographic_descender(), o.use_typographic_metrics()),
        None => (hhea_asc, hhea_desc, false),
    };
    let _ = writeln!(out, "pub static {name}: OwnFace = OwnFace {{");
    let _ = writeln!(out, "    upem: {upem}.0, hhea: ({hhea_asc}, {hhea_desc}), typo: ({typo_asc}, {typo_desc}), use_typo: {use_typo},");
    let _ = writeln!(out, "    glyphs: &[");
    for (&cp, &g) in &cmap {
        let adv = face.glyph_hor_advance(GlyphId(g)).unwrap_or(0);
        let bb = face.glyph_bounding_box(GlyphId(g));
        let (ink, x0, y0, x1, y1) = match bb {
            Some(r) => (true, r.x_min, r.y_min, r.x_max, r.y_max),
            None => (false, 0, 0, 0, 0),
        };
        let _ = writeln!(out, "        Glyph {{ cp: {cp}, gid: {g}, adv: {adv}, ink: {ink}, x0: {x0}, y0: {y0}, x1: {x1}, y1: {y1} }},");
    }
    let _ = writeln!(out, "    ],\n    kern: &[");
    for ((a, b), v) in &kern {
        let _ = writeln!(out, "        ({a}, {b}, {v}),");
    }
    let _ = writeln!(out, "    ],\n    ligs: &[");
    for s in &ligs {
        let _ = writeln!(out, "        &{s:?},");
    }
    let _ = writeln!(out, "    ],\n    triggers: &{:?},\n}};", triggers.iter().collect::<Vec<_>>());
    println!("cargo:warning={name}: {} 字形、{} 对字偶距、{} 个连字、{} 个替换触发", cmap.len(), kern.len(), ligs.len(), triggers.len());
}

fn main() {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../public/redist");
    let mut out = String::new();
    for (name, file) in [("BRAVURA", "Bravura.otf"), ("BRAVURA_TEXT", "BravuraText.otf")] {
        let p = root.join(file);
        println!("cargo:rerun-if-changed={}", p.display());
        let data = std::fs::read(&p).unwrap_or_else(|e| panic!("读 {}：{e}", p.display()));
        let face = Face::parse(&data, 0).unwrap_or_else(|e| panic!("解析 {}：{e}", p.display()));
        gen(&mut out, name, &face);
    }
    println!("cargo:rerun-if-changed=build.rs");
    std::fs::write(PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("ownfonts.rs"), out).unwrap();
}
