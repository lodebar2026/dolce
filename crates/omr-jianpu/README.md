# dolce-omr-jianpu

> Jianpu (numbered notation) recognition route of Dolce's OMR. Internal crate; use `dolce-omr`.

悦谱 Dolce 的**简谱识别路线**：各页原图 → `result::RecognizedScore`。

这是内部实现，识别的对外入口是 [`dolce-omr`](https://crates.io/crates/dolce-omr)（先按五线谱认，没有一页找到谱表才走简谱）。

## 流程

- `prep`：成像、连通块
- `frame`：数字高、数字行与行带、带内切格（数字 / 小节线 / 增时线 / 点）
- `notes`：读数、八度点、减时线、建音
- `marks`：临时升降号、倚音、顿音、重音、波音、延长记号
- `spans`：弧
- `text`：歌词、页眉、调号拍号速度
- `beats`：满拍裁决、可疑清单
- `vector`：矢量 PDF 的墨迹证据（按对象几何作答，不画整页）

## 链接

- API 文档：<https://docs.rs/dolce-omr-jianpu>
- 项目主页：<https://lodebar2026.github.io/dolce/>
- 源代码：<https://github.com/lodebar2026/dolce>（分层与各 crate 的关系见 [docs/架构.md](https://github.com/lodebar2026/dolce/blob/main/docs/架构.md)「目录」）

## 许可

MIT，见仓库 [LICENSE](https://github.com/lodebar2026/dolce/blob/main/LICENSE)。
