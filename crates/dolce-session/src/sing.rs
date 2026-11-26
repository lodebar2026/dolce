//! 按参照歌词生成段落标记与 `%%sing`（[`dolce_model::view::singfit`]）接上投影档排版：分遍要知道每段歌词在投影片上占几行。
//! 网页（wasm）、桌面（Tauri 排版线程）、命令行（系统量字）三处都走这里。

use dolce_engrave::Env;
use dolce_layout_jianpu::compose::layout_jianpu;
use dolce_model::doc::ScoreDoc;
use dolce_engrave::style::cascade::ctx;
use dolce_engrave::style::themes::{compute_style_for_paper, theme, ThemeId};
use dolce_model::view::singfit::{fit_sing, SingFit};
use serde_json::Value;

use crate::layout::{jianpu_config, JianpuRequest};

/// 出厂的投影档样式（命令行没有用户样式时用）
pub fn default_projection_style() -> Value {
    compute_style_for_paper(&[theme(ThemeId::Projection)], &ctx(&[("mode", Value::String("expanded".into())), ("engine", Value::String("jianpu".into()))])).0
}

/// 投影档请求；`style` 为 None 用出厂投影样式
pub fn projection_request(style: Option<Value>) -> JianpuRequest {
    JianpuRequest { view: "expanded".into(), style: Some(style.unwrap_or_else(default_projection_style)), no_reflow: false, break_desc: None, page: None, snippet: false, ink: None, layout: None }
}

/// 按投影档排一遍，回第 `song` 首每页几行（标题页不算）。`%%sing` 每遍写 `[rows=99]` 时一遍正好一页。
pub fn projection_rows(doc: &ScoreDoc, song: usize, req: &JianpuRequest, env: &Env) -> Option<Vec<usize>> {
    let mut req = req.clone();
    req.view = "expanded".into();
    let cfg = jianpu_config(&req, env).ok()?;
    let r = layout_jianpu(doc, &cfg, env);
    Some(r.placed.pages.iter().filter(|p| p.song == song && !p.title_page).map(|p| p.groups.len()).collect())
}

/// 拿参照歌词给第 `song` 首生成段落标记与逐遍演唱顺序（不改 `doc`；写回用 [`dolce_model::view::singfit::apply_sing_fit`]）
pub fn fit_sing_doc(doc: &ScoreDoc, song: usize, lyrics: &str, req: &JianpuRequest, env: &Env) -> SingFit {
    fit_sing(doc, song, lyrics, &|d: &ScoreDoc| projection_rows(d, song, req, env))
}

/// 交给编辑器的结果：段落标记（插在哪个和弦前）、`%%sing` 原文、差异与字数（`SingFit` 的字段 + `sing`）
pub fn fit_report(fit: &SingFit) -> Value {
    let mut v = serde_json::to_value(fit).unwrap_or(Value::Null);
    if let Value::Object(m) = &mut v {
        m.insert("sing".into(), Value::String(fit.sing_text()));
    }
    v
}

/// 编辑器入口（网页 wasm、桌面排版线程共用）：`req` 是投影档的 `JianpuRequest` JSON，回 [`fit_report`]
pub fn sing_from_lyrics_json(doc: &str, song: usize, lyrics: &str, req: &str, env: &Env) -> Result<Value, String> {
    let doc: ScoreDoc = serde_json::from_str(doc).map_err(|e| format!("ScoreDoc：{e}"))?;
    let mut req: JianpuRequest = if req.trim().is_empty() || req.trim() == "null" {
        projection_request(None)
    } else {
        serde_json::from_str(req).map_err(|e| format!("JianpuRequest：{e}"))?
    };
    // 没给样式按出厂投影档（`JianpuRequest` 缺省的是印刷档）
    if req.style.is_none() {
        req.style = Some(default_projection_style());
    }
    Ok(fit_report(&fit_sing_doc(&doc, song, lyrics, &req, env)))
}
