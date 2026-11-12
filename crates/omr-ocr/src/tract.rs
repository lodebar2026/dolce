//! 纯 Rust 推理（tract）：网页版 wasm 里没有 onnxruntime 的原生库，同一份 PP-OCR ONNX 改由 tract 跑。
//! 模型从字节加载（网页由 JS fetch 后交进来）。
//!
//! - 模型里 Paddle 导出时写的中间形状标注（`value_info`、输出形状）与 tract 自己推出的对不上，一律不读。
//! - rec：批与宽留成符号，一份计划跑所有形状。
//! - det：FPN 各层上采样后拼接，宽高是符号时 tract 证不出各层等宽（`ceil(x/32)*8` 一类），只能定值编；
//!   按输入形状各编一份留着（送检尺寸都是 32 的倍数、种类不多，编一份几十毫秒）。
use crate::{Infer, Model};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tract_onnx::prelude::*;

type Plan = Arc<TypedSimplePlan>;

pub struct TractInfer {
    rec: Plan,
    det: InferenceModel,
    det_plans: Mutex<HashMap<Vec<usize>, Plan>>,
}

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
        let rec = compile(parse(rec, "rec")?, |s| vec![s.sym("N").into(), 3.into(), 48.into(), s.sym("W").into()], "rec")?;
        Ok(TractInfer { rec, det: parse(det, "det")?, det_plans: Mutex::new(HashMap::new()) })
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
            Model::Rec => self.rec.clone(),
            Model::Det => self.det_plan(dims)?,
        };
        let t = Tensor::from_shape(dims, &input).map_err(|e| e.to_string())?;
        let out = plan.run(tvec!(t.into())).map_err(|e| e.to_string())?;
        let v = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
        Ok((v.iter().copied().collect(), v.shape().to_vec()))
    }
}
