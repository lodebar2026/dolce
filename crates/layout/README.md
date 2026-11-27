# dolce-layout

> Public layout entry point of Dolce: typeset a `ScoreDoc` as jianpu / staff / mixed pages, songbooks, and export PDF / PPTX.

悦谱 Dolce **排版的对外入口**。网页版（wasm）、桌面版（Tauri）、命令行 `dolce` 都经它排版。

## 内容

- `layout`：文档 → 页面场景。`layout_jianpu_doc`（简谱 / 投影档）、`layout_staff_doc`（五线谱 / 混排）、`engraved_music_xml`（带五线谱版面坐标的 MusicXML）；量字与 SMuFL 元数据由宿主经 `dolce_engrave::Env` 传入。
- `book`：成书排版——DrawList、书级部件（目录、索引、扉页、注解块、花边框……）、成书重排、混排歌本。
- `export`（`export` 特性）：场景 / 成书 → 矢量 PDF（krilla，嵌字、嵌不了的转曲）、场景 → PPTX。
- `sing`：按参照歌词生成段落标记与逐遍演唱顺序 `%%sing`，接上投影档排版。
- 根上的 `Session` 是宿主无关的文档会话骨架（修订号、过期拒绝），取页与写出还没接上。

## 特性

- `export`：PDF / PPTX 导出（带 `dolce-engrave/fontfile`）。
- `export-system`（缺省）：导出时用系统字体库。

## 链接

- API 文档：<https://docs.rs/dolce-layout>
- 项目主页：<https://lodebar2026.github.io/dolce/>
- 源代码：<https://github.com/lodebar2026/dolce>（分层与各 crate 的关系见 [docs/架构.md](https://github.com/lodebar2026/dolce/blob/main/docs/架构.md)「目录」）

## 许可

MIT，见仓库 [LICENSE](https://github.com/lodebar2026/dolce/blob/main/LICENSE)。
