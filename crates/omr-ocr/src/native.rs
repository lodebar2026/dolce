//! 原生推理（onnxruntime，经 `ort`）：每个模型一个会话池（缺省 3 会话 × 3 线程，`DOLCE_OCR_SESS` / `DOLCE_OCR_THREADS` 可调）。
//! 回归要确定性时用 1 线程（多线程浮点累加次序不定，末位差会让两可的判断翻转）。
use crate::{Infer, Model};
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static ENV: OnceLock<Result<ort::environment::Environment, String>> = OnceLock::new();

fn env() -> Result<&'static ort::environment::Environment, String> {
    ENV.get_or_init(|| ort::init().build().map_err(|e| e.to_string())).as_ref().map_err(|e| e.clone())
}

/// 模型文件名（web 仓库 `public/redist/ocr/`、桌面版资源目录 `ocr/` 同名）。
pub const REC_FILE: &str = "ch_PP-OCRv6_small_rec_infer.onnx";
pub const DET_FILE: &str = "ch_PP-OCRv4_det_infer.onnx";

pub struct NativeInfer {
    rec: Pool,
    det: Pool,
}

struct Pool {
    path: PathBuf,
    threads: usize,
    slots: Vec<Mutex<Option<Session>>>,
}

impl Pool {
    fn new(path: &Path, sessions: usize, threads: usize) -> Self {
        Pool { path: path.to_path_buf(), threads, slots: (0..sessions.max(1)).map(|_| Mutex::new(None)).collect() }
    }

    fn run(&self, input: Vec<f32>, dims: &[usize]) -> Result<(Vec<f32>, Vec<usize>), String> {
        // 取空闲的会话；都忙就等第一个
        let mut guard = self.slots.iter().find_map(|m| m.try_lock().ok()).map_or_else(|| self.slots[0].lock().map_err(|e| e.to_string()), Ok)?;
        if guard.is_none() {
            let s = Session::builder(env()?)
                .map_err(|e| e.to_string())?
                .with_intra_threads(self.threads)
                .map_err(|e| e.to_string())?
                .commit_from_file(&self.path)
                .map_err(|e| format!("加载 {} 失败：{e}", self.path.display()))?;
            *guard = Some(s);
        }
        let sess = guard.as_mut().unwrap();
        let iname = sess.inputs()[0].name().to_string();
        let tensor = Tensor::from_array((dims.iter().map(|&d| d as i64).collect::<Vec<_>>(), input)).map_err(|e| e.to_string())?;
        let outputs = sess.run(ort::inputs![iname.as_str() => tensor]).map_err(|e| e.to_string())?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        Ok((data.to_vec(), shape.iter().map(|&d| d as usize).collect()))
    }
}

impl NativeInfer {
    /// `dir` 里要有 `ch_PP-OCRv6_small_rec_infer.onnx` 与 `ch_PP-OCRv4_det_infer.onnx`（web 仓库 `public/redist/ocr/`）。
    pub fn new(dir: &Path, sessions: usize, threads: usize) -> Self {
        Self::with_paths(&dir.join(REC_FILE), &dir.join(DET_FILE), sessions, threads)
    }

    /// 模型文件各自给路径（桌面版从资源目录取）。
    pub fn with_paths(rec: &Path, det: &Path, sessions: usize, threads: usize) -> Self {
        NativeInfer { rec: Pool::new(rec, sessions, threads), det: Pool::new(det, sessions, threads) }
    }
}

impl Infer for NativeInfer {
    fn run(&self, model: Model, input: Vec<f32>, dims: &[usize]) -> Result<(Vec<f32>, Vec<usize>), String> {
        match model {
            Model::Rec => self.rec.run(input, dims),
            Model::Det => self.det.run(input, dims),
        }
    }
}
