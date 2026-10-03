# 悦谱 Dolce

**中文** | [English](README.en.md)

> 开源的简谱与五线谱编辑、识谱与排版工具：写谱、识谱、排版、试听、导出，浏览器即开即用，也有 Windows / macOS 桌面版；界面中英双语。

[![Release](https://img.shields.io/github/v/release/lodebar2026/dolce?display_name=tag)](https://github.com/lodebar2026/dolce/releases)
[![Live demo](https://img.shields.io/badge/%F0%9F%8C%90%20%E5%9C%A8%E7%BA%BF%E4%BD%BF%E7%94%A8-online-2b6cb0)](https://lodebar2026.github.io/dolce/)
![Platform](https://img.shields.io/badge/platform-Web%20%7C%20macOS%20%7C%20Windows-555)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 快速入口

| | 入口 | 说明 |
| :-: | --- | --- |
| 🌐 | **[在线使用](https://lodebar2026.github.io/dolce/)** | 免安装，浏览器直接打开 |
| 🍎 | **[macOS 版下载](https://github.com/lodebar2026/dolce/releases/latest)**（`.dmg`，Apple Silicon） | 首次打开提示“已损坏”见 [macOS 打不开](docs/macOS-打不开.md) |
| 🪟 | **[Windows 版下载](https://github.com/lodebar2026/dolce/releases/latest)**（`x64-setup.exe`） | 安装包，Windows 10/11 x64 |

![简谱图片识别后与原图并排对照](docs/screenshot-zh.png)

<sub>四声部简谱图片（《圣哉！圣哉！圣哉！》）识别后打开「并排原图」：左边是原图，右边是按原样排出的谱，点一个音两边同时框出。</sub>

## 特性

**编辑**
- 左侧源码、右侧实时简谱，边打字边重排；支持 **123**（本项目的简谱主格式，见下）、**JP-Word `.jpwabc`**、
  **文本谱**（番茄简谱 / 诗歌本「动态谱」）、**ABC** 四种文本格式，语法高亮与诊断提示。
- **可视化编辑**：直接在谱面上选中、插入、修改音符与记号（唱名或音名、音级 / 半音 / 八度、升降号、时值、增时线、小节线、圆滑线 / 延音线、
  延长号、重音、换行换页），键盘、右键菜单、记号面板三种入口；简谱、五线谱、混排各档都能改；改动落回源码，与代码区共用撤销。
  键位对齐常见打谱软件（↑↓ 调内音级、Alt+↑↓ 半音、Ctrl/⌘+↑↓ 八度）。
- **小节操作**：插入、追加、删除小节，合并 / 拆分小节，换调号、拍号、速度，小节线样式、房号与跳转记号。
- 歌词逐字录入（空格跳下一个音，连打汉字自动一字一音）、和弦名、文字与力度录入；连音；复制粘贴（跨格式按唱名重写）与 `R` 重复；
  按小节跳、跳到第几小节；移调（全曲换调或选区移半音）。
- 选中即显示读数：声部、第几小节第几拍、音名与唱名、时值。
- 点选音符或歌词即双向定位到源码；拍数与拍号对不上的小节标红。
- **声部面板**（合唱谱）：增删、排序、改名、谱号、移调乐器、拆分 / 合并闭合谱、歌词复制；五线谱 / 混排里隐藏声部；
  试听静音、独奏（练声部）、各声部音量；简谱旋律与歌词各取哪个声部可选。
- **简繁转换**：整篇转歌词、标题、词曲信息，乐谱代码不动。
- **中英双语界面**（含帮助）：按浏览器语言自动选择，「设置 → 其他 → 界面语言」随时切换、无需刷新；英文版入口 <https://lodebar2026.github.io/dolce/en/>。

**识谱（OMR，本地离线）**
- 拖入简谱**照片、截图或扫描 PDF**，识别成 123 简谱再排版：音符、时值、歌词逐字对位、页眉标题 / 词曲 / 调号，
  四声部简谱按声部分开。完全在浏览器或桌面本地运行，图片不上传。
- 识别后可进入**原图对照**：识别结果按源图坐标叠加在二值图上逐音核对，点选即定位到源码，也能直接试听；可在对照上直接改谱，改过、删掉、新插的音按原图位置即时标出。
  识别没把握的音和字**标黄**，一键逐处跳过去核对。
- 回到排版稿后打开「原图片段」，选中哪个音，右下角就显示原图上那一行；或打开「**并排原图**」，左边铺整页原图、两边选中互通，还可收起源码区让原图与排版稿各占一半。
- **原图页**：识别前后都能调整原图顺序、增删、旋转 90°、裁剪，再整首重新识别；识别失败时起始页也给「旋转 / 裁剪原图后重试」。
- **五线谱识别**：文字层完整的五线谱 PDF、扫描或拍照的五线谱图片 / PDF 都能识别成 MusicXML，进五线谱 / 混排视图后可直接在谱面上改；拖入时按有没有五线谱表自动判断走简谱还是五线谱，也可手动指定。
  多声部谱的「谱表 ↔ 声部」对应认错了，可在声部面板改，按新对应重建、不重新识别。
- 命令行识别（`omr-cli.mjs 图片 --lyrics 歌词.txt`）可附上同一首的**歌词文本**做词谱互证：形近字按歌词选字、
  补回漏读的字，版本用字不同、字多字少、疑似漏认的弧与反复顺序对不上的地方逐条报告，不擅改。

**排版**
- 四档视图：**展开**（反复与多段歌词逐遍展开、一屏一段，适合投影）、**原样**（按原谱排、多段词叠排，适合印刷）、
  **五线谱**、**混排**（五线谱上叠一层简谱）。
- **按乐句重排**：综合歌词标点与音乐信号（延长号、终止线、长音、休止、连线）重新断行；可一键还原原始排版。
- 纸张、方向、边距、页眉字体字号可设；诗集样式表 `.ss` 统一一本歌集的字体、配色与版式。

**试听**
- 按谱面速度演奏，光标跟随；可暂停、拖进度条、点音符从那里接着播，×0.5～×2 倍速；多声部可调各声部音量。
- 循环播放选中的一段（没选循环整首）；节拍器每拍一声。

**保存、另存为与导出**
- 保存写回原格式；**另存为**可在 123 / JPWABC / ABC / 文本谱之间互转，转换前先列出目标格式装不下的内容。
- 识别过的谱保存为**识别项目**（`.dolce`）：原图、识别结果与在改的谱一起存，重开后接着在原图对照上校对，不必重新识别。
- **自动保存**：改过没存的内容几秒后在本机存一份草稿，意外关闭或刷新后重开时可恢复。有没存的内容时，打开别的文件、载入示例、重新识别或关闭窗口前会先问一声。
- 导出：简谱档出 **矢量 PPTX**、**MIDI**、**MusicXML**；五线谱 / 混排档出 **PNG**、**PDF**、**MIDI**、**MusicXML**。
  导出的 MIDI 按演唱顺序逐遍带上歌词，可直接导进歌声合成软件（如 X Studio）让虚拟歌手演唱。

## 123 格式

123 是本项目的**简谱主格式**：**简谱的 ABC 方言**——字段头（`X:` `T:` `K:` `M:` `w:` …）、反复、房号、
多声部、演唱顺序等机制沿用 ABC 记谱，音乐体换成简谱数字。纯文本、UTF-8，适合手写，
也能无损承载从 MusicXML、ABC、文本谱与图片识别转来的谱。

```
X:1
T:奇异恩典
C:词 John Newton
K:1=F
M:3/4
Q:1/4=76
5, | 1 - 3_ 1_ | 3 - 2 | 1 - 6, | 5, - $
w:奇异恩_典，何等甘甜，
5, | 1 - 3_ 1_ | 3 - 2 | 5 - - | 5 - |]
w:我罪已_得赦免_
```

- 完整规范：[docs/格式/123格式.md](docs/格式/123格式.md)
- 界面里 **帮助 → 123 格式** 有逐条说明，每条都附实时渲染的效果。

## 支持的格式

| 格式 | 扩展名 | 打开 | 编辑 | 保存 / 另存为 | 说明 |
| --- | --- | :-: | :-: | :-: | --- |
| 123 | `.123` | ✅ | ✅ | ✅ | 简谱主格式 |
| JP-Word | `.jpwabc` | ✅ | ✅ | ✅ | 与 JP-Word 互通 |
| 文本谱 | `.pu` `.fq` `.jps` `.txt` | ✅ | ✅ | ✅ | 番茄简谱脚本、诗歌本文本谱（「动态谱」），自动识别方言 |
| ABC | `.abc` | ✅ | ✅ | ✅ | 多声部、反复、房号、和弦、装饰音等 |
| MusicXML | `.xml` `.musicxml` | ✅ | ✅（谱面上直接改） | ✅ | 各档都能在谱面上改音符、小节、歌词与标题；单声部谱也可转成 123 等文本格式编辑 |
| 图片 / PDF | `.png` `.jpg` `.webp` `.pdf` | 识谱 | — | — | 简谱图片与扫描 PDF；五线谱 PDF、扫描或拍照的五线谱 |
| 识别项目 | `.dolce` | ✅ | ✅ | ✅ | 原图 + 识别结果 + 在改的谱，重开不重新识别 |

## 安装

- **浏览器在线版**（免安装）：<https://lodebar2026.github.io/dolce/>
- **macOS 版**（Apple Silicon，`Dolce_<版本>_aarch64.dmg`）与 **Windows 版**（x64，`Dolce_<版本>_x64-setup.exe`）：
  [最新 Release](https://github.com/lodebar2026/dolce/releases/latest)
- macOS 首次打开提示“已损坏”或“无法验证开发者”？应用未签名，属正常现象，一条命令即可解决，见
  [docs/macOS-打不开.md](docs/macOS-打不开.md)。

## 开发

技术栈、构建命令、分层与模块地图见 [docs/架构.md](docs/架构.md)；需求与各模块说明见 [docs/](docs/)。
回归脚本与测试语料不在本仓库。

## 致谢

本项目站在这些工作之上，一并致谢：

- [open-fanqie](https://github.com/Linho1219/open-fanqie)（MIT）—— 番茄简谱脚本的第三方开源
  解析/渲染实现；番茄简谱脚本规范文档见 <https://fqdoc.linho.cc/>
- [ABC 记谱标准](https://abcnotation.com/wiki/abc:standard:v2.1) —— 123 格式的字段与结构所本
- [Bravura / SMuFL](https://github.com/steinbergmedia/bravura)（Steinberg，SIL OFL）——
  音乐字体与字形元数据
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)（Apache-2.0）—— 识谱里数字与歌词的
  识别模型；推理运行时用 [onnxruntime-web](https://github.com/microsoft/onnxruntime)
- [CodeMirror 6](https://codemirror.net/)、
  [Tauri 2](https://tauri.app/)、[Vite](https://vite.dev/)、[TypeScript](https://www.typescriptlang.org/)
  —— 编辑器 / 桌面外壳 / 构建
- [opencc-js](https://github.com/nk2028/opencc-js)（简繁转换）、
  [pdf.js](https://mozilla.github.io/pdf.js/)（PDF 栅格化）、
  [jsPDF](https://github.com/parallax/jsPDF)（PDF 导出）、
  [smplr](https://github.com/danigb/smplr)（试听音源）、
  [FluidR3 GM](https://github.com/gleitz/midi-js-soundfonts)（试听的钢琴音色，CC BY 3.0）、
  [fflate](https://github.com/101arrowz/fflate)（PPTX 打包）、
  [opentype.js](https://opentype.js.org/)（字形轮廓）

## 许可

本项目代码以 MIT 授权（见 [LICENSE](LICENSE)）。随附 Bravura 字体按 SIL OFL 授权
（见 `public/redist`），试听的钢琴音色（FluidR3 GM）按 CC BY 3.0 授权
（见 `public/redist/soundfont/LICENSE.txt`）；各第三方依赖的许可以其自身声明为准。
