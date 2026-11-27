# dolce-omr-core

> Shared foundation of Dolce's optical music recognition (jianpu and staff): image ops, OCR, PDF/image sources, recognition → `ScoreDoc`. Internal crate; use `dolce-omr`.

悦谱 Dolce **识别（OMR）的共用底层**，简谱、五线谱两条路线都只向下依赖它。不开特性时无平台依赖，能编到 wasm。

这是内部实现，识别的对外入口是 [`dolce-omr`](https://crates.io/crates/dolce-omr)。

## 内容

- `image` / `geom` / `pixel`：二值图与灰度图、统计与矩形运算、像素内核（连通域、形态学、游程、轮廓、二值化）。
- `text`：和弦文法、页眉分类、歌词切字与对音、词间空格、速度 / 跳转 / 力度词表。
- `sheet`：谱面元素层——谱表与局部坐标、元素库与证据、归属与互斥。
- `todoc`：识别结果直出 `ScoreDoc`，参照歌词互证。
- `ocr`：PP-OCR 识别与检测的前后处理、推理后端、结果缓存。
- `source`（`pdf` 特性）：取数层——PDF（PDFium）与图片 → 页面对象、文字、内嵌图原始像素、整页渲染。
- `stage` / `progress`：阶段产物缓存、进度与取消。

## 特性

- `native`：OCR 用 ONNX Runtime（ort）推理。
- `tract`：OCR 用纯 Rust 的 tract 推理。
- `pdf`：取数层；原生构建要 PDFium 动态库（构建脚本会下载缓存，或用 `PDFIUM_LIB_PATH` 指定）。

运行 OCR 还要 PP-OCR 模型文件，不随 crate 发布，见仓库 `public/redist/ocr/` 或发布页的命令行包。

## 链接

- API 文档：<https://docs.rs/dolce-omr-core>
- 项目主页：<https://lodebar2026.github.io/dolce/>
- 源代码：<https://github.com/lodebar2026/dolce>（分层与各 crate 的关系见 [docs/架构.md](https://github.com/lodebar2026/dolce/blob/main/docs/架构.md)「目录」）

## 许可

MIT，见仓库 [LICENSE](https://github.com/lodebar2026/dolce/blob/main/LICENSE)。
