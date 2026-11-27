# dolce-layout-staff

> Staff notation and mixed (staff + jianpu) layout engine of Dolce. Internal crate; use `dolce-layout`.

悦谱 Dolce 的**五线谱 / 混排引擎**：读入建树（`read`）→ 横向、分系统、纵向（`pass`）→ 画系统与简谱叠层（`render`、`overlay`）→ 装页（`pages`）。

这是内部实现，一般不直接用：排版的对外入口是 [`dolce-layout`](https://crates.io/crates/dolce-layout)（`layout::layout_staff_doc`、`layout::engraved_music_xml`）。
节点放在 arena 里用下标互指（`model::StaffLayout`），画出来的是 `dolce-engrave` 的场景节点。

## 链接

- API 文档：<https://docs.rs/dolce-layout-staff>
- 项目主页：<https://lodebar2026.github.io/dolce/>
- 源代码：<https://github.com/lodebar2026/dolce>（分层与各 crate 的关系见 [docs/架构.md](https://github.com/lodebar2026/dolce/blob/main/docs/架构.md)「目录」）

## 许可

MIT，见仓库 [LICENSE](https://github.com/lodebar2026/dolce/blob/main/LICENSE)。
