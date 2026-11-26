# dolce-layout-jianpu

> Jianpu (numbered musical notation) layout engine of Dolce. Internal crate; use `dolce-layout`.

悦谱 Dolce 的**简谱引擎**：排版行视图 → 定位结构（`place`）→ 场景节点（`compose`），另含分页（`paginate`）。

这是内部实现，一般不直接用：排版的对外入口是 [`dolce-layout`](https://crates.io/crates/dolce-layout)（`layout::layout_jianpu_doc`）。
谱面元素的画法在 `dolce-engrave`，本 crate 只管把一行行谱排到位、拼成页。

## 链接

- 项目主页：<https://lodebar2026.github.io/dolce/>
- 源代码：<https://github.com/lodebar2026/dolce>（分层与各 crate 的关系见 [docs/架构.md](https://github.com/lodebar2026/dolce/blob/main/docs/架构.md)「目录」）

## 许可

MIT，见仓库 [LICENSE](https://github.com/lodebar2026/dolce/blob/main/LICENSE)。
