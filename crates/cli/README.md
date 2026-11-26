# dolce-cli

悦谱（Dolce）命令行工具：本地乐谱识别（OMR）、多格式互转、矢量排版导出（PDF / PNG / SVG / PPTX）、标准 MIDI 导出与歌本切分。

> 项目主页：<https://lodebar2026.github.io/dolce/>  
> 源代码仓库：<https://github.com/lodebar2026/dolce>

## 安装

```bash
cargo install dolce-cli
```

安装后可执行 `dolce --help` 查看全部子命令与参数。

## 常用用法

```bash
# 格式互转（支持 .123 / .abc / .jcx / .jpwabc / .jps / .jly / .musicxml / .mxl / .mid）
dolce convert song.123 -f musicxml -o song.musicxml

# 排版导出矢量 PDF / PNG / SVG / PPTX
dolce convert song.123 -o song.pdf
dolce convert song.123 -o song.pptx

# 导出标准 MIDI（含演唱顺序展开与逐遍歌词）
dolce convert song.123 -o song.mid

# 本地识谱（图片或 PDF → 诗歌本文本谱 / 123 / MusicXML 等）
dolce omr sheet.jpg -f 123 -o song.123
dolce omr choir.pdf -f musicxml -o choir.musicxml

# 歌本切分（整本 PDF / 页图目录 → 一首一张图）
dolce split songbook.pdf -o out/
```

## 运行时依赖说明

- **`dolce convert`**：已内置 Bravura 音乐字体及 SMuFL 元数据，谱面格式、MIDI、PDF / SVG / PPTX 开箱即用；导出 PNG 要 PDFium 动态库（同下）。
- **`dolce omr` / `dolce split`（OCR 识谱）**：
  - 需要通过环境变量 `OMR_MODELS` 指定 PP-OCR 模型目录（可在 GitHub Releases 下载预打包 CLI 压缩包或从源码仓库 `public/redist/ocr/` 获取）。
  - 处理 PDF 输入需要 PDFium 动态库：构建时 `dolce-omr-source` 会自动缓存到 `~/.cache/dolce-pdfium/`；也可通过 `PDFIUM_LIB_PATH` 指定。

## 开源许可与致谢

- 代码采用 [MIT License](https://github.com/lodebar2026/dolce/blob/main/LICENSE)。
- 内置的 Bravura 音乐字体（`Bravura.otf`）及元数据采用 [SIL Open Font License 1.1](https://scripts.sil.org/OFL) 许可。
