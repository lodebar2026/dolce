//! 书清单 `book.json`（照 `src/pdflayout/manifest.ts`）：一本歌本有哪些歌、什么顺序、逐曲 meta 覆盖、引用哪份 `.ss`。
//! 格式见 docs/格式/ss.md §8。清单是数据，版式在 `.ss` 里。
//!
//! TS 只做形状校验、其余字段原样留着；这里没认的键收进 `extra`，写回 JSON 时原样带出。

use dolce_model::doc::{Creator, Identification, Song, SongMeta};
use dolce_model::metakeys::overlay_meta;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ManifestSong {
    /// 谱文件，相对清单里的 `root`（或清单文件所在目录）
    pub file: String,
    /// 曲号（目录、`@song #曲号` 限定用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    /// 覆盖谱文件里的标题
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 覆盖词曲署名（整组替换）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creators: Option<Vec<Creator>>,
    /// 覆盖版权
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rights: Option<String>,
    /// 按键浅覆盖 `Song.meta`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<SongMeta>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookManifest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 歌本样式表（`.ss`）路径
    pub style: String,
    /// 按装页口径叠加的样式表：`@flow song-start` 的档（`new-page` / `continue`）→ `.ss` 路径，接在 `style` 之后
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_by_flow: Option<indexmap::IndexMap<String, String>>,
    /// 谱文件根目录
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    pub songs: Vec<ManifestSong>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// 清单项覆盖到读进来的谱上（就地改；`applyManifestSong`）
pub fn apply_manifest_song(song: &mut Song, entry: &ManifestSong) {
    if let Some(t) = &entry.title {
        song.work.title = Some(t.clone());
    }
    if let Some(n) = &entry.number {
        song.work.number = Some(n.clone());
    }
    if entry.creators.is_some() || entry.rights.is_some() {
        let id = song.identification.get_or_insert_with(|| Identification { creators: vec![], rights: None, software: None });
        if let Some(c) = &entry.creators {
            id.creators = c.clone();
        }
        if let Some(r) = &entry.rights {
            id.rights = Some(r.clone());
        }
    }
    if let Some(m) = overlay_meta(song.meta.as_ref(), entry.meta.as_ref()) {
        song.meta = Some(m);
    }
}

/// 校验清单形状（`parseManifest`）：至少要有 `style`（串）与 `songs`（数组），每项要有 `file`（串）。
pub fn parse_manifest(text: &str) -> Result<BookManifest, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("book.json 不是合法 JSON：{e}"))?;
    let ok = v.as_object().is_some_and(|m| m.get("songs").is_some_and(Value::is_array) && m.get("style").is_some_and(Value::is_string));
    if !ok {
        return Err("book.json 至少要有 style 与 songs".into());
    }
    for (i, s) in v["songs"].as_array().unwrap().iter().enumerate() {
        if !s.get("file").is_some_and(Value::is_string) {
            return Err(format!("book.json songs[{i}] 缺 file"));
        }
    }
    serde_json::from_value(v).map_err(|e| format!("book.json 读不进：{e}"))
}
