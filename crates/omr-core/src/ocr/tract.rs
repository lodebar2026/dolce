//! 纯 Rust 推理（tract）：网页版 wasm 里没有 onnxruntime 的原生库，同一份 PP-OCR ONNX 改由 tract 跑。
//! 模型从字节加载（网页由 JS fetch 后交进来）。
//!
//! - 模型里 Paddle 导出时写的中间形状标注（`value_info`、输出形状）与 tract 自己推出的对不上，一律不读。
//! - rec：批与宽留成符号，一份计划跑所有形状。
//! - det：FPN 各层上采样后拼接，宽高是符号时 tract 证不出各层等宽（`ceil(x/32)*8` 一类），只能定值编；
//!   按输入形状各编一份留着（送检尺寸都是 32 的倍数、种类不多，编一份几十毫秒）。
//! - rec 的两种常见形状另编定形计划：常规文本条（1×3×48×320）与数字格（16×3×48×48，不满 16 格补空白格、多的分几次）。
//!   定形计划比符号计划快 4~5 倍（原生量过：文本条 35→7.4 ms、16 格 104→27 ms，输出差在 1e-5 以内），编一份几十毫秒。
use crate::ocr::{Infer, Model};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tract_onnx::prelude::*;

type Plan = Arc<TypedSimplePlan>;

pub struct TractInfer {
    rec: Plan,
    rec_model: InferenceModel,
    /// rec 的定形计划（按输入形状）
    rec_fixed: Mutex<HashMap<Vec<usize>, Plan>>,
    det: InferenceModel,
    det_plans: Mutex<HashMap<Vec<usize>, Plan>>,
}

/// 文本条的常规张量宽（同 `lib.rs` 的 `REC_MAXW`）与数字格边长（`DIGIT_W`）。
const STRIP_W: usize = 320;
const CELL_W: usize = 48;
/// 数字格定形计划一批至多几格；不满的补到 4 / 8 / 16 里最小够用的那档（一份活常只几格，补满 16 格白算）。
const CELL_N: usize = 16;
const CELL_TIERS: [usize; 3] = [4, 8, 16];

fn parse(bytes: &[u8], what: &str) -> Result<InferenceModel, String> {
    tract_onnx::onnx()
        .with_ignore_value_info(true)
        .with_ignore_output_shapes(true)
        .model_for_read(&mut std::io::Cursor::new(bytes))
        .map_err(|e| format!("读 {what} 模型失败：{e}"))
}

/// `dims` 由模型自己的符号表给（tract 要求符号出自模型管的 `SymbolScope`）。
fn compile(m: InferenceModel, dims: impl FnOnce(&SymbolScope) -> Vec<TDim>, what: &str) -> Result<Plan, String> {
    let dims = dims(&m.symbols);
    m.with_input_fact(0, f32::fact(dims).into())
        .and_then(|m| m.into_optimized())
        .and_then(|m| m.into_runnable())
        .map_err(|e| format!("编 {what} 模型失败：{e}"))
}

impl TractInfer {
    pub fn new(rec: &[u8], det: &[u8]) -> Result<Self, String> {
        let rec_model = parse(rec, "rec")?;
        let rec = compile(rec_model.clone(), |s| vec![s.sym("N").into(), 3.into(), 48.into(), s.sym("W").into()], "rec")?;
        let t = TractInfer { rec, rec_model, rec_fixed: Mutex::new(HashMap::new()), det: parse(det, "det")?, det_plans: Mutex::new(HashMap::new()) };
        // 定形计划加载时就编好（网页版几个 Worker 各编各的，用到时再编会卡在分轮的某一轮里）
        t.rec_plan(&[1, 3, 48, STRIP_W])?;
        for n in CELL_TIERS {
            t.rec_plan(&[n, 3, 48, CELL_W])?;
        }
        Ok(t)
    }

    fn rec_plan(&self, dims: &[usize]) -> Result<Plan, String> {
        let mut plans = self.rec_fixed.lock().map_err(|e| e.to_string())?;
        if let Some(p) = plans.get(dims) {
            return Ok(p.clone());
        }
        let p = compile(self.rec_model.clone(), |_| dims.iter().map(|&d| d.into()).collect(), "rec")?;
        plans.insert(dims.to_vec(), p.clone());
        Ok(p)
    }

    /// 数字格按 [`CELL_N`] 格一批跑定形计划，不满的补空白格到 [`CELL_TIERS`] 的一档，输出接回去。
    fn run_cells(&self, input: &[f32], dims: &[usize]) -> Result<(Vec<f32>, Vec<usize>), String> {
        let per = 3 * 48 * CELL_W;
        let mut out = Vec::new();
        let mut shape = Vec::new();
        for chunk in input.chunks(CELL_N * per) {
            let n = chunk.len() / per;
            let pn = CELL_TIERS.into_iter().find(|&t| t >= n).unwrap_or(CELL_N);
            let plan = self.rec_plan(&[pn, 3, 48, CELL_W])?;
            let mut buf = chunk.to_vec();
            buf.resize(pn * per, 0.0);
            let t = Tensor::from_shape(&[pn, 3, 48, CELL_W], &buf).map_err(|e| e.to_string())?;
            let o = plan.run(tvec!(t.into())).map_err(|e| e.to_string())?;
            let v = o[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
            let row: usize = v.shape()[1..].iter().product();
            out.extend(v.iter().take(n * row).copied());
            shape = v.shape().to_vec();
        }
        shape[0] = dims[0];
        Ok((out, shape))
    }

    fn det_plan(&self, dims: &[usize]) -> Result<Plan, String> {
        let mut plans = self.det_plans.lock().map_err(|e| e.to_string())?;
        if let Some(p) = plans.get(dims) {
            return Ok(p.clone());
        }
        let p = compile(self.det.clone(), |_| dims.iter().map(|&d| d.into()).collect(), "det")?;
        plans.insert(dims.to_vec(), p.clone());
        Ok(p)
    }
}

impl Infer for TractInfer {
    fn run(&self, model: Model, input: Vec<f32>, dims: &[usize]) -> Result<(Vec<f32>, Vec<usize>), String> {
        let plan = match model {
            Model::Rec if dims[3] == CELL_W && dims[2] == 48 => return self.run_cells(&input, dims),
            Model::Rec if dims == [1, 3, 48, STRIP_W] => self.rec_plan(dims)?,
            Model::Rec => self.rec.clone(),
            Model::Det => self.det_plan(dims)?,
        };
        let t = Tensor::from_shape(dims, &input).map_err(|e| e.to_string())?;
        let out = plan.run(tvec!(t.into())).map_err(|e| e.to_string())?;
        let v = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
        Ok((v.iter().copied().collect(), v.shape().to_vec()))
    }
}
