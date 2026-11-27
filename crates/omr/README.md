# dolce-omr

> Public optical music recognition (OMR) entry point of Dolce: recognize jianpu and staff notation from PDFs and images.

悦谱 Dolce **识别（OMR）的对外入口**：简谱、五线谱（含混排）的图片与 PDF → 乐谱模型。
桌面版（Tauri）、网页版（wasm）、命令行 `dolce` 都经这里，不各自拼「文件 → 页面 → 判路 → 识别」。

## 内容

- `Doc`：打开 PDF（PDFium）或单张图片；页数、页尺寸、整页渲染。
- `recognize`：判路识别——先按五线谱认，没有一页找到谱表就走简谱；带进度与取消（`Hook`）。
- `Recognition`：五线谱交识别会话（改关联、切分、钉住都在会话上），简谱交识别结果与二值图；再经 `dolce-omr-core` 的 `todoc` 直出 `ScoreDoc`，用 `dolce-model` 写成各格式。
- `staff_binary`：五线谱核对视图的底图。
- `Handle`：桌面版、网页版共用的文档句柄。
- `book`（`book` 特性）：歌本切分——整本分页歌谱 → 一首一张图，按书内目录核对缺号与重号。

## 特性

- `parallel`（缺省）：多页并行（rayon）。
- `native`（缺省）：OCR 用 ONNX Runtime；`tract`：改用纯 Rust 推理。
- `book`：歌本切分。

运行时要 PP-OCR 模型文件与 PDFium 动态库，不随 crate 发布；开箱即用的命令行见 [`dolce-cli`](https://crates.io/crates/dolce-cli) 或仓库发布页。

## 链接

- API 文档：<https://docs.rs/dolce-omr>
- 项目主页：<https://lodebar2026.github.io/dolce/>
- 源代码：<https://github.com/lodebar2026/dolce>（分层与各 crate 的关系见 [docs/架构.md](https://github.com/lodebar2026/dolce/blob/main/docs/架构.md)「目录」）

## 许可

MIT，见仓库 [LICENSE](https://github.com/lodebar2026/dolce/blob/main/LICENSE)。
