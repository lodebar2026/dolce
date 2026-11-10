# 识别：Rust 工作区（`crates/`，迁移中）

判据在本页。

## 职责

识别（简谱、五线谱含混排、歌本切分）用 Rust 重新设计实现的落脚处。迁移期间 TS 实现照常是产品与回归走的那一份；
Rust 这边不要求与 TS 逐字相同，按各语料的 GT 判分追平或超过基线验收，旧判据只作参考，全部达标后才切换、删 TS。

## 入口

| crate | 作用 |
|---|---|
| `crates/omr-source` | 取数层（迁移中）：现在只有 PDFium 能力验证的探针 `examples/rawglyph.rs`（逐字取字形轮廓）、`examples/images.rs`（内嵌图原始像素与页上矩阵） |
| `crates/omr-core` | 基础层，不依赖平台（要能编到 wasm）：`image`（二值图、灰度图、矩形）、`geom`（对应 `omrkit/geom.ts`）、`pixel`（像素内核，原 `native/omrkernels/src/core`）、`js`（数值口径）、`stage`（阶段缓存） |

`native/omrkernels` 现在只是 `omr-core::pixel` 的 napi 外壳（Node 回归用，TS 识别退役时一并删）。

## 关键判据

- `omr-core::js`：`Math.round`（半数向正无穷）、`x | 0`、稳定且比较函数不成全序也不 panic 的排序。参考旧判据、要照同一口径算的地方用它。
- **阶段缓存**（`stage.rs`）：键 = 阶段名 + 代码指纹 + 各输入的内容指纹；产物落盘时记自己的内容指纹，下游的键用上游产物的内容指纹。
  上游代码改了但这一页产物没变，下游照样命中。命中时只回指纹，值用到才从盘上解。写盘先写临时文件再改名（并行进程写同一个键）。
- 矩形坐标用 `f64`（TS 是 number，量出来的中心与折算后的框带小数）；二值图一字节一像素、值 0/1，与 TS 的 `Binary` 同排法，落盘按位打包（低位在前，同回归的二值图缓存）。

- **PDFium**（pdfium-render）：绑定特性 `pdfium_<构建号>` 必须与动态库同一个 chromium 构建号，否则绑定时缺符号（`latest` 跟着 crate 版本走，0.9.5 的 latest 是 8125，本机库是 7881，报 `FPDF_StructElement_GetRawType` 找不到）。现固定 `pdfium_7881`。
- **字形轮廓要直接调原生接口** `FPDFFont_GetGlyphPath(font, Unicode 值, 字号)`：它收的是 Unicode，PDFium 内部转字符码。
  pdfium-render 的 `font.glyphs()` 拿 0 号试探字形数，符号字体（Maestro）试出 0，之后 `get` 全失败——不能用它。
  实测（2026-11-10）：Anastasia 1684/1685（差的是空格）、Maestro 225/225 与 214/214；子集字体 `LNFFGN+Maestro` 0/54（字符码 0x87 之类没有 Unicode 映射，PDFium 回的就是码本身，反查不回字符码）。
  这类字的退路待定：按字体程序（`FPDFFont_GetFontData`）自己解 / 渲染该字的框取位图签名。
- **内嵌图**：`get_raw_image` 给原始尺寸、不重采样；CCITT（2482×3510，约 20 ms）、DCT（RGB / 灰度）、Flate 都取得出，页上矩阵从 `matrix()` 取，一页好几块的（星空下的祝福）各自带矩阵。JBIG2 语料里没碰到，未验。

## 回归

```bash
cd crates && cargo test          # Rust 单元测试
npm run build:native && npm test -- omrkit/kernels   # 像素内核 TS ↔ Rust 逐项比对（私有仓库用例）
```

## 已知限制

只有基础层；取数、OCR、谱面元素类、两条路线、歌本切分、命令行与回归 runner 都还没有。
