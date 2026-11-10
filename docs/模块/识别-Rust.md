# 识别：Rust 工作区（`crates/`，迁移中）

判据在本页；各阶段的识别判据仍见现有各识别模块页，移植不改判据。

## 职责

识别（简谱、五线谱、歌本切分）从 TS 迁到 Rust 的落脚处。迁移期间 TS 实现照常是产品与回归走的那一份，
Rust 这边逐阶段移植、同一输入下与 TS 的阶段快照和判据样本逐字比对，全部对上后才切换、删 TS。

## 入口

| crate | 作用 |
|---|---|
| `crates/omr-core` | 基础层，不依赖平台（要能编到 wasm）：`image`（二值图、灰度图、矩形）、`geom`（对应 `omrkit/geom.ts`）、`pixel`（像素内核，原 `native/omrkernels/src/core`）、`js`（数值口径）、`stage`（阶段缓存） |

`native/omrkernels` 现在只是 `omr-core::pixel` 的 napi 外壳（Node 回归用，TS 识别退役时一并删）。

## 关键判据

- **数值口径走 `omr-core::js`**：`Math.round` 是半数向正无穷（Rust 的 `f64::round` 远离零）、`x | 0` 是按 2^32 回绕的截断（Rust 的 `as i32` 饱和）、
  `Array.prototype.sort` 稳定且比较函数回数值。移植的判据不直接用 Rust 标准库的对应物。比较函数不成全序的调用点（按容差比的）结果依赖排序算法，逐处核对。
- **阶段缓存**（`stage.rs`）：键 = 阶段名 + 代码指纹 + 各输入的内容指纹；产物落盘时记自己的内容指纹，下游的键用上游产物的内容指纹。
  上游代码改了但这一页产物没变，下游照样命中。命中时只回指纹，值用到才从盘上解。写盘先写临时文件再改名（并行进程写同一个键）。
- 矩形坐标用 `f64`（TS 是 number，量出来的中心与折算后的框带小数）；二值图一字节一像素、值 0/1，与 TS 的 `Binary` 同排法，落盘按位打包（低位在前，同回归的二值图缓存）。

## 回归

```bash
cd crates && cargo test          # Rust 单元测试
npm run build:native && npm test -- omrkit/kernels   # 像素内核 TS ↔ Rust 逐项比对（私有仓库用例）
```

## 已知限制

只有基础层；取数、OCR、谱面元素类、两条路线、歌本切分、命令行与回归 runner 都还没有。
