//! tract 与 ort 对账：同一首曲子识别时每次推理两个后端都跑，比输出张量与贪心解码，各计耗时。
//! `cargo run --release -p dolce-omr-cli --example tract_vs_ort -- jianpu|staff 文件…`
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::native::NativeInfer;
use dolce_omr_ocr::tract::TractInfer;
use dolce_omr_ocr::{Infer, Model, Ocr, OcrCache};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Default, Debug)]
struct Stat {
    calls: usize,
    ort_s: f64,
    tract_s: f64,
    max_diff: f32,
    /// rec：逐时间步取最大类不同的步数 / 总步数；det：概率图过 0.3 阈值不同的像素 / 总像素
    flips: usize,
    total: usize,
    shape_err: usize,
}

struct Dual {
    ort: NativeInfer,
    tract: TractInfer,
    stat: Mutex<[Stat; 2]>,
}

impl Infer for Dual {
    fn run(&self, model: Model, input: Vec<f32>, dims: &[usize]) -> Result<(Vec<f32>, Vec<usize>), String> {
        let t0 = Instant::now();
        let a = self.ort.run(model, input.clone(), dims).inspect_err(|e| eprintln!("ort：{e}"))?;
        let t1 = Instant::now();
        let b = self.tract.run(model, input, dims).inspect_err(|e| eprintln!("tract：{e}"))?;
        let t2 = Instant::now();
        let mut st = self.stat.lock().unwrap();
        let s = &mut st[if model == Model::Rec { 0 } else { 1 }];
        s.calls += 1;
        s.ort_s += (t1 - t0).as_secs_f64();
        s.tract_s += (t2 - t1).as_secs_f64();
        if a.1 != b.1 {
            s.shape_err += 1;
            return Ok(a);
        }
        for (x, y) in a.0.iter().zip(&b.0) {
            s.max_diff = s.max_diff.max((x - y).abs());
        }
        if model == Model::Rec {
            let c = *a.1.last().unwrap();
            for (ra, rb) in a.0.chunks(c).zip(b.0.chunks(c)) {
                let am = |r: &[f32]| (0..c).fold(0, |m, k| if r[k] > r[m] { k } else { m });
                s.total += 1;
                if am(ra) != am(rb) {
                    s.flips += 1;
                }
            }
        } else {
            for (x, y) in a.0.iter().zip(&b.0) {
                s.total += 1;
                if (*x > 0.3) != (*y > 0.3) {
                    s.flips += 1;
                }
            }
        }
        Ok(a)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let kind = args[0].clone();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../public/redist/ocr");
    let rec = std::fs::read(dir.join("ch_PP-OCRv6_small_rec_infer.onnx")).unwrap();
    let det = std::fs::read(dir.join("ch_PP-OCRv4_det_infer.onnx")).unwrap();
    let t0 = Instant::now();
    let tract = TractInfer::new(&rec, &det).unwrap();
    eprintln!("tract 加载 + 编模型 {:.2} s", t0.elapsed().as_secs_f64());
    let dual = Dual { ort: NativeInfer::new(&dir, 1, 1), tract, stat: Mutex::new(Default::default()) };
    let dict = std::fs::read_to_string(dir.join("ppocrv6_dict.txt")).unwrap();
    let dual: &'static Dual = Box::leak(Box::new(dual));
    struct Fwd(&'static Dual);
    impl Infer for Fwd {
        fn run(&self, m: Model, i: Vec<f32>, d: &[usize]) -> Result<(Vec<f32>, Vec<usize>), String> {
            self.0.run(m, i, d)
        }
    }
    for f in &args[1..] {
        let ocr = CachedOcr::new(Some(Ocr::new(Box::new(Fwd(dual)), &dict)), OcrCache::memory());
        let t = Instant::now();
        let ok = run(&kind, f, &ocr);
        eprintln!("{f}：{ok} {:.1} s", t.elapsed().as_secs_f64());
    }
    let st = dual.stat.lock().unwrap();
    for (name, s) in ["rec", "det"].iter().zip(st.iter()) {
        println!(
            "{name}：{} 次，ort {:.2} s，tract {:.2} s（{:.1} 倍），最大差 {:.2e}，翻转 {}/{}，形状不同 {}",
            s.calls, s.ort_s, s.tract_s, s.tract_s / s.ort_s.max(1e-9), s.max_diff, s.flips, s.total, s.shape_err
        );
    }
}

fn run(kind: &str, f: &str, ocr: &CachedOcr) -> String {
    use dolce_omr_source::raster::{image_file, page_image};
    use dolce_omr_source::{ContentOpts, PdfDoc};
    use dolce_omr_staff::page::{recognize_source, PageSource};
    let bytes = std::fs::read(f).unwrap();
    let srcs: Vec<PageSource> = if f.ends_with(".pdf") {
        let doc = PdfDoc::open(bytes).unwrap();
        (0..doc.page_count())
            .map(|i| {
                let pc = doc.content(i, ContentOpts { images: true, paths: true, text: true, outlines: true }).unwrap();
                PageSource { raster: page_image(&pc), content: Some(pc), rendered: None }
            })
            .collect()
    } else {
        vec![PageSource { raster: Some(image_file(&bytes).unwrap()), content: None, rendered: None }]
    };
    if kind == "jianpu" {
        let imgs: Vec<_> = srcs.into_iter().filter_map(|s| s.raster).collect();
        match dolce_omr_jianpu::recognize(&imgs, ocr) {
            Ok(r) => format!("{} 字节 JSON", serde_json::to_string(&r).unwrap().len()),
            Err(e) => e,
        }
    } else {
        let pages: Vec<_> = srcs.iter().filter_map(|s| recognize_source(s, Some(ocr))).collect();
        let song = dolce_omr_staff::song::assemble(&pages, None);
        format!("{} 页、{} 字节 MusicXML", pages.len(), dolce_omr_todoc::staff::score_to_music_xml(&song.score).len())
    }
}
