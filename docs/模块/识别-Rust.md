# 识别：Rust 工作区（`crates/`，迁移中）

判据在本页。

## 职责

识别（简谱、五线谱含混排、歌本切分）用 Rust 重新设计实现的落脚处。迁移期间 TS 实现照常是产品与回归走的那一份；
Rust 这边不要求与 TS 逐字相同，按各语料的 GT 判分追平或超过基线验收，旧判据只作参考，全部达标后才切换、删 TS。

## 入口

| crate | 作用 |
|---|---|
| `crates/omr-build` | 构建脚本工具：`fingerprint(名, 目录…)` 按源码目录算阶段代码指纹，导出 `OMR_CODE_<名>`（阶段缓存键的一部分；上游 crate 的目录要一并列上） |
| `crates/omr-cli` | 命令行 `omr-cli`：现在只有 `regress`（见「回归」） |
| `crates/omr-source` | 取数层：`pdf.rs`（PDFium：页数、内嵌图原始像素与矩阵、路径、文字层、字形轮廓、整页渲染）、`raster.rs`（取页图：最大块 / 拼图页 / 按矩阵转正、图片文件按 EXIF 转正；`Binarizer` 灰度各倍数只算一次、几档 Sauvola 共用积分图；极性自检） |
| `crates/omr-ocr` | PP-OCR：识别（CTC、逐字位置、前 K 候选）、DBNet 检测（含分块）、原生推理（ort 会话池）、按条内容指纹的落盘缓存 |
| `crates/omr-sheet` | 谱面元素公共件：现在有 `Staff`（五条线位、各线带厚、共用偏移曲线、左右端、单线谱）与谱表局部坐标（`pos` / `y_of`：第一线 0、往下每半格 +1） |
| `crates/omr-staff` | 五线谱路线：`prep/`（成像、网点网纹）、`frame/`（找谱表、墨层、系统、小节线）。`examples/` 是对 TS 阶段快照的对账与排查工具（`vs_ts_staves`、`vs_ts_bars`、`dbg_systems`、`dbg_bars`、`dbg_crop`） |
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
  这类字先按字框渲染取位图签名兜底，大量出现再解字体程序（`FPDFFont_GetFontData`）。
- **内嵌图**：`get_raw_image` 给原始尺寸、不重采样；CCITT（2482×3510，约 20 ms）、DCT（RGB / 灰度）、Flate 都取得出，页上矩阵从 `matrix()` 取，一页好几块的（星空下的祝福）各自带矩阵。JBIG2 语料里没碰到，未验。

### 五线谱：预处理与框架结构

- **成像按谱表定**（`prep/imaging.rs`）：1 位原图直接取位；灰度 / 彩色走 Sauvola 0.5，再看量到的谱表——线距 < 14 且线细（线宽 / 线距 < 0.22，或放大后再量 < 0.16）的放大一倍；
  一行谱都找不出逐档放松（0.35 / 0.2 / 0.1）；线宽 / 线距 < 0.06 的细线扫描件把松阈值图（0.2）里 1.5 格以上的纵向游程并回来；
  松阈值图里细长横向游程只补断口，多找出谱行、或某行沿线有墨的列涨过 0.15 才留（只换那一行的谱表带）。网点率（谱表带内、线上孤点不计）> 0.13 去网，
  针孔率 > 0.012 补针孔，孤点过密的块抹掉。不推平、不纠斜。
- **找谱表**（`frame/staves.rs`）：逐列（步长 4）找五段细黑四段等距 → 串轨迹（短截也收，拼完再按列数筛：压满符杠的谱行逐列五连断成许多小截）→ 两截按相邻两端接回 → 五线共用偏移曲线 → 沿线验墨定左右端。
  **单线谱**：五线表以外的细实横线，沿线连墨、上下一两格没有平行线、两根以上上下对称各伸 1.2~3 格的竖笔穿过；建成五线表（实线当第三线，`one_line`）。
- **墨层不去线**（`frame/ink.rs`）：三值图，谱线带里纵向墨段不比线宽厚多少的像素标存疑（`LINE`），原图不改。竖段：逐列纵向墨段（接一两像素白缝）单列够总长三分之一就收，相邻列连成一段后再按总长筛。
- **系统**（`frame/systems.rs`）：两行之间左端窗口（往外 3.5 格、往里半格）有墨的行过九成算连着；不够的看松阈值图里贴左端最强的一列；再不够的看两行之间有没有一根虚线
  （顺着墨走、每行可挪一列：扫描错切的竖线是歪的；墨过半、最长断口不到 0.8 格）；左端标记断开的单行按间距并回去。
- **小节线**（`frame/bars.rs`，在符头之前定）：竖段纵贯一行谱、两端不伸出谱表（贯穿小节线只许伸进同系统邻行）、端点旁不挂符头样的墨块；
  竖笔在谱表里横向连着一团墨（挂空心头的干、降号肚子共用的竖笔）的标**存疑**，单行系统里摘掉、多行系统里要别的行有孤立的一笔作证。
  多行系统同 x 归簇互证：别的行有、本行没有的回原图验竖墨补（三行以上过半的行有就照补，记 `Vote`）；少数行有、别的行同处也没有贯穿竖墨的摘。

## 回归

```bash
cd crates && cargo test                                   # 单元测试
cargo run --release -p dolce-omr-cli -- regress <jianpu|solo|chorus|xinbian> [--only=子串] [--jobs=N]
cargo run --release -p dolce-omr-staff --example vs_ts_bars -- chorus|solo   # 框架结构对 TS 阶段快照（线索，不当对错）
npm run build:native && npm test -- omrkit/kernels        # 像素内核 TS ↔ Rust 逐项比对（私有仓库用例）
```

`regress` 的流程：
1. 曲目由私有仓库 `rust-omr/corpus.mjs` 列（照判分脚本同一套找曲规则，不在 Rust 里另抄）。
2. 各曲并行识别，产物落盘到 `dev/data/rust-omr/runs/<档>/`：五线谱 `<曲>.rec.musicxml` + `<曲>.rec.json`（版面摘要，形状见私有仓库 `chorus-opslib.mjs::recLayoutOf`），
   简谱 `<曲>.rec.json`（`RecognizedScore`，由 `rust-omr/rec-to-123.mjs` 走 `omrEmitter("123")` 转成 `.rec.123`）。
3. 判分脚本离线读（`solo-ops.mjs --from`、`chorus-ops.mjs --from --out-dir`），不碰 `dev/data` 下别的报告。
4. 与 TS 基线逐曲比：基线是 `rust-omr/archive-baseline.sh` 在分支起点（main `c7c02820`）归档的读数与识别产物（`dev/data/rust-omr/ref-c7c02820/`）。
   `--replay=<归档目录下某档>` 不识别、拿归档的 TS 产物走一遍，用来自测流程（读数应与基线逐曲相同）。

判分脚本、语料、基线都在私有仓库；判分要 `web/`（main 检出）里的 `out/cli/j123.js` / `omr.js`，`--web=` 可另指。

## 已知限制

- 五线谱只到框架结构（版面分区未做）；结构信息、音符、文字、线性符号、简谱路线、歌本切分、wasm 都还没有，`omr-cli` 的识别是空壳。
- 子集字体无 Unicode 映射的字形取不到轮廓，退路（渲染字框取位图签名）等矢量路时做。
