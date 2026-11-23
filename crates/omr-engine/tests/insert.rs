//! 点原图补认：删掉一个音，在它原来的位置点一下补回来，音高与时值要回到原样（语料、OCR 缓存在私有仓库，没有就跳过）。
use dolce_omr_core::progress::Hook;
use dolce_omr_engine::{insert, recognize, region, Doc, Opts, Recognition, RegionClass};
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::native::NativeInfer;
use dolce_omr_ocr::{Ocr, OcrCache};
use dolce_omr_staff::session::Op;
use dolce_omr_staff::song::Fact;
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn ocr() -> CachedOcr {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../public/redist/ocr");
    let dict = std::fs::read_to_string(dir.join("ppocrv6_dict.txt")).unwrap();
    CachedOcr::new(Some(Ocr::new(Box::new(NativeInfer::new(&dir, 2, 1)), &dict)), OcrCache::open(root().join("dev/data/rust-omr/ocr-cache/session.json")))
}

/// 破碎（干净版）第 2 页开会话。
fn open() -> Option<(Doc, dolce_omr_staff::session::Session, Vec<usize>)> {
    let bytes = std::fs::read(root().join("dev/testdata/合唱谱/破碎/S014320OC.pdf")).ok()?;
    let doc = Doc::open(bytes).unwrap();
    let Recognition::Staff { session, pages } = recognize(&doc, &ocr(), &Opts { pages: vec![1], ..Default::default() }, &Hook::NONE).unwrap() else { panic!("应认成五线谱") };
    Some((doc, session, pages))
}

#[test]
fn region_rereads_lyrics() {
    let Some((doc, mut session, pages)) = open() else { return };
    // 头几个歌词字的框并起来重读，读出来应与原来一样
    let syls: Vec<_> = session.song().score.parts.iter().flat_map(|p| p.measures.iter()).flat_map(|m| m.events.iter()).flat_map(|e| e.lyrics.iter()).filter(|l| l.number == 1).filter_map(|l| Some((l.src.at?, l.text.clone()))).take(4).collect();
    assert_eq!(syls.len(), 4);
    let r = dolce_omr_core::geom::union_rects(&syls.iter().map(|s| s.0.rect).collect::<Vec<_>>());
    let pad = r.h * 0.3;
    let rect = dolce_omr_core::image::Rect::new(r.x - pad, r.y - pad, r.w + 2.0 * pad, r.h + 2.0 * pad);
    let n = region(&doc, &mut session, &pages, syls[0].0.page - 1, rect, RegionClass::Lyric, &ocr()).unwrap();
    let after: Vec<String> = session.song().score.parts.iter().flat_map(|p| p.measures.iter()).flat_map(|m| m.events.iter()).flat_map(|e| e.lyrics.iter()).filter(|l| l.number == 1).map(|l| l.text.clone()).take(4).collect();
    eprintln!("重读 {n} 个：{:?} → {after:?}", syls.iter().map(|s| &s.1).collect::<Vec<_>>());
    assert!(n >= 3);
}

#[test]
fn drop_then_insert_restores_note() {
    let Some((doc, mut session, pages)) = open() else { return };
    // 挑几个单音（有干、不在和弦里）逐个试
    let picks: Vec<_> = session
        .song()
        .score
        .parts
        .iter()
        .flat_map(|p| p.measures.iter())
        .flat_map(|m| m.events.iter())
        .filter(|e| e.pitches.len() == 1 && e.stem_up.is_some() && e.src.len() == 1)
        .filter_map(|e| Some((e.src[0].src.rid?, e.src[0].src.at?, e.pitches[0], e.ntype)))
        .step_by(7)
        .take(5)
        .collect();
    assert!(!picks.is_empty());
    let mut ok = 0;
    for (rid, at, pitch, ntype) in &picks {
        session.apply(Op::Pin { rid: *rid, fact: Fact::Drop }).unwrap();
        let new = insert(&doc, &mut session, &pages, at.page - 1, at.rect.x + at.rect.w / 2.0, at.rect.y + at.rect.h / 2.0).unwrap();
        let e = session.song().score.parts.iter().flat_map(|p| p.measures.iter()).flat_map(|m| m.events.iter()).find(|e| e.src.iter().any(|h| h.src.rid == Some(new))).expect("补的音要写出");
        eprintln!("{rid}: {pitch:?} {ntype:?} → {new}: {:?} {:?}", e.pitches, e.ntype);
        ok += (e.pitches == vec![*pitch] && e.ntype == *ntype) as usize;
    }
    assert!(ok * 5 >= picks.len() * 4, "补回 {ok}/{}", picks.len());
}
