//! 悦谱 Dolce 的样式层（照 `src/style/`）：`.ss` 解析与写出、级联、内置主题、键表、单位、纸、页眉字体、模板区域排版，
//! 以及三个适配器——简谱尺子 [`jianpu::jianpu_style_of`]（→ [`jianpustyle::JianpuStyle`]）、
//! 成书 [`bookss::book_style_of`]（→ BookStyle）、五线谱 / 混排 [`staff::apply_staff_style`]（→ [`staff::MixedOptions`]）。
//!
//! 样式表是动态形状（`.ss`、内置主题、用户层 JSON 叠出来），用 `serde_json::Value`（键保插入序）承载，读法照 JS；
//! 尺子是定形结构。

pub mod book;
pub mod bookss;
pub mod bookstyle;
pub mod cascade;
pub mod fonts;
pub mod header;
pub mod jianpu;
pub mod jianpudefault;
pub mod jianpustyle;
pub mod keys;
pub mod paper;
pub mod sheet;
pub mod ss;
pub mod staff;
pub mod template;
pub mod themes;
pub mod units;
pub mod value;
