# Rust 移植：JS 口径与踩坑

> 模型、格式、排版、导出从 TS 迁到 Rust 时定下的口径与踩过的坑，按主题记。哪些决策不要推翻见 [../架构.md](../架构.md) §8；
> 识别是重新设计的，不在此列（见 [识别-Rust](../模块/识别-Rust.md)「设计原则」）。
> 迁移时要与旧 TS 零差异，所以下面很多条是「照 JS 的行为算」；TS 已删，以后改这些地方不必再守旧口径，但要知道输出会变、先回归。

## 数值（`dolce-model::base::js`）

JS 语义陷阱统一收在 `dolce-model::base::js` 并单测，别在各 crate 里各写一份。

- **数转字符串**（`num_to_string`，ECMAScript `Number::toString`）：取 Rust `{:e}` 的最短往返数字，再按规范排指数。
  两个同样短的候选离精确值一样近时**取末位为偶**（同 V8；Rust `{:e}` 取大的）：`0.90000152587890625` → `0.9000015258789062`。SVG、写出端的数字都走它。
- **`to_fixed`**：恰在中间的判法——二进制小数位数 = f + 1 才是精确的半，取大；其余走精确舍入。
- `Math.round`（半数向正无穷）、`x | 0`、`max` / `min` 的 NaN 口径、Map 数字键（`NumKey`）；**排序要稳定，比较函数不成全序时也不许 panic**（JS 的 `sort` 不报错）。
- `Fraction` 照 TS 用 `f64`；含 NaN 时 TS 的 gcd 死循环，Rust 回 NaN。
- **NaN 过 JSON 成 `null`**，`f64` 字段读不进，报 `engine.badInput`。
- **过边界的 JSON 要开 `serde_json` 的 `float_roundtrip`**，否则框坐标、尺寸末位与 JS 不同。识别的 OCR 得分是 `f32`，比较时按 `as f64`（TS 读到的就是这个数）。

## 字符串与编码

- **源区间、XML 节点区间、报错位置一律按 UTF-16 码元**（CodeMirror 的口径）：`Utf16Index` 只记非 ASCII 字符，字节 ↔ UTF-16 二分换算。
- **文本格式解析器把原文转成 `&[u16]` 扫**（语法字符都在 ASCII），取出的片段经 `from_utf16_lossy` 回字符串。
  非 BMP 字被逐码元切开时 TS 留半个代理，Rust 成 U+FFFD；孤立代理过 wasm 边界同样成 U+FFFD（例如 `.jcx` 写不出的字清单）。原文不过边界，读入后门面换回 JS 那份。
- XML 数字实体指到代理区 → U+FFFD；负数码位 → `XmlError`（TS 抛 `RangeError`）。
- 正则逐条手译成等价判断，回溯次序照原式；`\p{L}` / `\p{P}` 用 `unicode-general-category`，不引正则库。
- 旧 TS 按 UTF-16 码元截断、算占比的地方（成书 `indexPages` 截断、`chordLineRole` 占比）照搬了，扩展区字会被切半 / 算偏（现有数据没有）。
- **GBK / BIG5 用 encoding_rs 的 WHATWG 解码器**。GBK 写出的反查表照 TS 的做法由解码器逐对建、先到先得，**不用 encoding_rs 的编码器**：
  它与旧 TS 差 19 字（€ U+20AC 旧写 `A2E3`、它写单字节 `80`；18 个私用区字旧的写不出、它写得出）。
- **Node 的 ICU 解码器 GBK / BIG5 不全照 WHATWG**（BIG5 HKSCS 段出私用区字、坏尾字节不出替换字符）；Rust 与浏览器一致，所以 Node 命令行读这类字节的结果随之与浏览器相同。

## 对象身份

TS 靠对象引用认的东西（`WeakMap` 缓存、`Set<Note>`、`Map<Element>`、`b.pages[0] === dp`、闭包里抓的对象）在 Rust 里一律换成下标、元素 id 或 `Oid`：

- `{ ...obj }`、`structuredClone` 出来的新对象 `Oid::NONE`（表层绑定随之丢，同旧行为）；要按身份记的临时旁表，投影期间借 `Measure.oid` 编临时号，元素级的按小节内下标，用完清掉。
- **共用对象的副作用要模拟**：TS `splitStaves` 拆出的几条谱表共用原小节的 `barlines` 数组（浅拷贝，`structuredClone` 也保留共享），往一条加 fine / coda 别的跟着有——
  `directions_as_marks` 照此模拟（同一声部拆出、同一小节小节线一开始相同的算共用，改一处同步）。
- **TS 改坏输入的不照搬**：简谱识别建模 `measuresOfRow` 整行没有小节线时回的是 `row.nums` 本身，并跨行小节时把下一行的音推进识别结果（第二次建模结果就不同）；Rust 不改输入。对拍时两边各喂一份没动过的输入。
- 插入序：JS `Map` / 对象键的插入序照搬（删了再存排到最后），写出依赖顺序的一律 `IndexMap` / `Vec`。
- TS 的 `i + 1` 在 `usize::MAX` 上溢出回 0 这类地方用 `checked_add`（`helpers::break_after(part, usize::MAX)` 踩过）。

## 浮点末位

- 经 `cos` / `atan2` / `log10` 算出的数（弧控制点、三连音、滑音），V8 与 Rust libm 末位可能不同。路径 `d` 串因此变，量字录放器按串作键就对不上——
  `ReplayMeasurer::with_path_fallback()` 没录到的路径盒现算（Node 后端本就是纯算），量字差与逻辑差仍分得开。
- 运算次序不同也会让末位变：排版切到 Rust 后指纹不取整有差、取两位小数逐页一致，基线按 Rust 不取整的输出重写。
- **阈值处离散翻转**（断行、分页因末位翻行）是骨架差，不是数差：逐例查，必要时复刻 JS 的算式次序。

## 边界与 wasm

- 数据过边界一律 JSON 字符串，失败抛 `Error`（message 是 `EngineError` 的 JSON：`Stale` / `Failure`）。输入结构全加 `deny_unknown_fields`（内部标签的枚举也生效）。
- 字符串字面量联合用 `str_enum!`（`dolce-model/src/strenum.rs`）：认得的进具名变体，认不得的原样进 `Other(String)`，ts-rs 只导出认得的那几个。
- **serde 的内部标签枚举很占体积**：派生的 `#[serde(tag = "kind")]` 不知道标签在第几个键，先把整个对象读进中间缓冲（`Content`）再解一遍，
  枚举底下每个类型（`Chord` / `Note` / `Measure` …）都另编一份「从缓冲读」的解码。TS 持有模型镜像、整份 JSON 送回，所以开机那份 wasm 里这些解码都在。
  `Element`、`InlineItem`、`MusicElement`、`EditCmd` 的 `Deserialize` 改成手写（`dolce-model::base/src/tagged.rs`）：第一个键就是标签走快路，剩下的键直接交给变体的派生解码；
  标签不在第一个（TS 手拼的对象）收进 `Value`、写回文本再走快路同一份代码。JSON 形状、ts-rs 生成的类型都不变；`EditCmd` 变体多、只派生 `Deserialize`，
  用 `#[serde(remote = "Self")]` 派生外部标签的固有函数、交 `TagEnum` 适配，不逐个写。2026-11-23 实测 dolce_wasm 7735 → 7296 KB（gzip 2803 → 2666 KB）；
  入口改成先解成 `Value` 再 `from_value` 反而大 160 KB（缓冲那份还在、又多一份）。剩下的 `ss::Expr` 等约 60 KB 没改。
  核对办法：本地语料 1460 份 `ScoreDoc` / 文本谱 AST 往返（含键倒序走慢路）与派生版逐字相同；`modelEdit` 两千多次编辑与改前那份 wasm 逐字相同（只有缺字段的报错多了「at line … column …」）。
- **开机那份 wasm 不带正则引擎**：regex 连同它的 Unicode 表约 700 KB（gzip 260 KB），简谱排版里只用了三个简单式子（SVG path 切记号、`FontSize:` / `Margin:` 版面指令），
  改成手写扫描（`compose/brace.rs::tokens`、`grid.rs::font_size_pairs` / `margin_pairs`），单测里拿原正则对拍几千个伪随机串。dolce-wasm 依赖链里再引正则前先想想有没有别的写法。
- **编译档**（`crates/Cargo.toml` 的 `wasm-dolce`）：`opt-level = 3` + fat LTO + 单代码单元。`s` 档 gzip 小两成多但慢 10~22%、`z` 档慢 30~60%，开机排版计算都在这份里，不换；
  wasm-opt 在这之上让 gzip 变大，不调。`.jcx` 码表（encoding_rs 约 180 KB）单出一份 `dolce_jcx_wasm` 按需载。
- **ts-rs**：`crates/.cargo/config.toml` 设 `TS_RS_EXPORT_DIR` → `src/engine/gen/`，多类型并进一个 `*.gen.ts`；每个进程第一次写会覆盖整份文件，所以 `gen:types` 先跑 dolce-model 再跑 dolce-model::base。
- **wasm 里 panic 会弄坏整个实例**（`unreachable` 陷阱，之后同一实例的调用都不可靠，网页版得刷新）；原生那边有 `catch_unwind`。缺码位、越界之类在 wasm 里要回 `Err`，别 panic。

## 构建与对拍的坑

- **对拍参照 wasm 要用独立的 cargo target 目录**：临时工作树的 `crates/target` 若链回主检出共用，工作树里编出的参照 wasm 会覆盖主检出的产物，
  cargo 还按修改时间把工作树编的 dolce-* 当成新的——主检出再编出来的是旧代码。
- 对拍要有反证：故意改错一处，看对拍报不报（没报说明那条分支没被语料走到）。语料没走到的分支在 TS 删掉后只能补夹具按语义核。
- 量字录制要整批录、不能逐档丢：TS 的量字缓存会把重复调用藏掉。
- 排版对拍分两道门：开发门回放录下的量字、容差 1e-6，用来分开逻辑差与量字差；验收门 Rust 自己量字、骨架一字不差、坐标差 ≤ 0.5。
