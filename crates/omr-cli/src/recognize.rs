//! 一档语料的一首曲子 → 识别产物。两条路线落地后在这里接；现在一律回「未实现」，回归流程照样能跑通（判分报缺产物）。
use std::path::Path;

/// 识别产物：判分脚本 `--from` 读的那几样文件的内容。
#[allow(dead_code)] // 两条路线落地前没人造它
pub enum RecOutput {
    /// 五线谱：MusicXML 与版面摘要（形状见私有仓库 `chorus-opslib.mjs::recLayoutOf`；独唱谱只要 `notes` / `rowSp`）
    Staff { musicxml: String, layout: serde_json::Value },
    /// 简谱：识别结果（形状同 web `omrkit/types.ts::RecognizedScore`），由私有仓库 `rec-to-123.mjs` 转 123 再判
    Jianpu { recognized: serde_json::Value },
}

pub fn recognize(kind: &str, inputs: &[String]) -> Result<RecOutput, String> {
    let _ = (kind, inputs.iter().map(Path::new).count());
    Err("尚未实现".into())
}
