# dolce-cli

> Command-line tool of Dolce: recognize jianpu / staff notation from images and PDFs, convert between score formats, typeset to PDF / PNG / SVG / PPTX, export MIDI, and split songbooks.

悦谱 Dolce 的**命令行工具**，命令名 `dolce`：本地识谱（OMR）、多格式互转、排版导出（矢量 PDF / PNG / SVG / 矢量 PPTX）、标准 MIDI 导出与歌本切分。
排版走 [`dolce-layout`](https://crates.io/crates/dolce-layout)，识别走 [`dolce-omr`](https://crates.io/crates/dolce-omr)，与网页版、桌面版同一套 Rust 代码，不依赖 Node。

## 安装

```bash
cargo install dolce-cli
```

装好后 `dolce --help` 列出全部子命令与参数。不想自己编译、要开箱即用的识谱，可下载仓库发布页的 `dolce-cli-<版本>-<平台>` 压缩包（带 OCR 模型与 PDFium）。

## 子命令

```bash
# 格式互转（输入 .123 / .abc / .jcx / .jpwabc / .jps / .jly / .musicxml / .mxl / .mid；-f 缺省时按 -o 的扩展名定）
dolce convert song.123 -f musicxml -o song.musicxml
dolce convert 谱子目录/ -f abc -o 出目录/          # 批量：目录取里面认得的乐谱文件

# 排版导出（--view=auto|jianpu|expanded|staff|mixed、--paper、--landscape、--dpi）
dolce convert song.123 -o song.pdf
dolce convert song.123 --view=staff -o song.svg
dolce convert song.123 -o song.pptx               # 固定按投影档出片

# 标准 MIDI（按演唱顺序展开，带声部名与逐遍歌词；--tempo、--no-lyrics、--metronome）
dolce convert song.123 -o song.mid

# 识谱（图片或 PDF → 诗歌本文本谱 / 123 / ABC / MusicXML 等，先按五线谱认、没有谱表就走简谱）
dolce omr sheet.jpg -f 123 -o song.123
dolce omr choir.pdf -f musicxml -o choir.musicxml

# 歌本切分（整本 PDF / 页图目录 → 一首一张图，按书内目录核对缺号与重号）
dolce split songbook.pdf -o out/
```

## 运行时依赖

- **`dolce convert`**：随包内置 Bravura 音乐字体与 SMuFL 元数据，谱面格式、MIDI、PDF / SVG / PPTX 开箱即用；导出 PNG 要 PDFium 动态库（见下）。
- **`dolce omr` / `dolce split`**：
  - PP-OCR 模型不随 crate 发布：用环境变量 `OMR_MODELS` 指定模型目录，或放在可执行文件旁的 `models/`；模型在仓库 `public/redist/ocr/` 或发布页的命令行压缩包里。
  - 读 PDF 要 PDFium 动态库：`cargo install` 时 `dolce-omr-core` 的构建脚本会下载并缓存到 `~/.cache/dolce-pdfium/`；也可用 `PDFIUM_LIB_PATH` 指定，或放在可执行文件旁。图片输入不需要 PDFium。

## 链接

- 项目主页：<https://lodebar2026.github.io/dolce/>
- 源代码：<https://github.com/lodebar2026/dolce>（分层与各 crate 的关系见 [docs/架构.md](https://github.com/lodebar2026/dolce/blob/main/docs/架构.md)「目录」）

## 许可

代码 MIT，见仓库 [LICENSE](https://github.com/lodebar2026/dolce/blob/main/LICENSE)；内置的 Bravura 字体与元数据为 [SIL Open Font License 1.1](https://openfontlicense.org/)（故整体标 `MIT AND OFL-1.1`）。
