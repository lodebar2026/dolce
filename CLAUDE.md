# 悦谱 Dolce

简谱与五线谱的编辑、识谱与排版（123 / JP-Word `.jpwabc` / 文本谱 / ABC / MusicXML）：Tauri 2 + TypeScript + SVG。
旧名 jpeditor 已全部改掉：仓库、在线版地址、桌面版标识符 `io.github.lodebar2026.dolce`、Cargo 包名 `dolce`、localStorage 键前缀 `dolce-*`、
草稿库 IndexedDB 名 `dolce`、MusicXML 写出端署名 `Dolce`。旧名下的设置与草稿不迁移。
排版、渲染、模型、编辑全在前端 TS；Rust 只做原生加速（见架构决策 A3/A4）。

文档分四层，**动某一块之前先翻对应那层**——那些阈值和判据多半是拿具体曲子换来的，别照直觉改：

- [docs/需求.md](docs/需求.md) 做什么 · [docs/架构.md](docs/架构.md) 怎么分层、哪些决策不要推翻
- [docs/模块/](docs/模块/) 每个模块一页：职责/入口/判据/回归/限制（20 篇）
- [docs/格式/](docs/格式/) 格式规范：[123格式](docs/格式/123格式.md)（简谱主格式）、[jpwabc](docs/格式/jpwabc.md)、[Muse jcx](docs/格式/jcx.md)；
  样式定制见 [docs/样式机制.md](docs/样式机制.md)
- [docs/实现/](docs/实现/) 判据与踩坑全录（各模块页开头有指向对应篇的链接；没有单独实现篇的写明判据在本页）
- 还要做什么只记在本地私有仓库的 `../dev/docs/待办.md`（做完的条目直接删）；README 中英两份（`README.md` / `README.en.md`）要同步改

## 命令

构建、类型检查、桌面调试命令见 [docs/架构.md](docs/架构.md)「技术栈与构建」。
回归脚本、语料与基线不在本仓库（本地私有仓库，从本仓库根跑 `node ../dev/scripts/xxx.mjs`）；
`scripts/` 只留发布链路：`release.sh`、`pack-omr.mjs`、`win-crt.mjs`、`vcredist.mjs`，外加随 OMR 包分发的 `omr-cli.mjs`。
文档里写的 `../dev/scripts/xxx.mjs` 都在私有仓库。

## 约定

- 测试语料与 GT（`testdata/`）只留本地，不入库；`testdata/` 只放语料与 GT，回归基线、快照、报告等派生数据放本地私有仓库。
  各模块页的「回归」一节同此。
- 提交信息用简要中文，不要 `Co-Authored-By` 尾注。
- TS 严格模式 + `noUnusedLocals/Parameters`。
- **界面文字走 `t()` / `data-i18n`**（`src/i18n/`），不在界面代码里写中文字面量；新键 zh.ts、en.ts 两边同加，见 [编辑器](docs/模块/编辑器.md)「界面语言」。
- **PUA 码位用 `String.fromCharCode(0x...)`**，切勿在源码里写字面 PUA 字符（Write 工具会损坏字节）。
- 数 XML 元素的正则一律写 `<name[ >]`（否则 `<note>` 会命中 `<notehead>`）。
- **Bravura（SMuFL）的字体盒不能当墨迹盒用**：它的全局 ascent−descent 约 4 em，按字体度量算高度、
  或对 `<text>` 调 `getBBox()`（得到的是整行字体盒），一个升降号、三连音数字、力度字形就把行高/裁剪框撑出几个字号的空白。
  排版期用紧包围盒——`SmuflText` 自带 bound、音乐段 `TextFrame.inkBound`、字形盒走 `smuflMeta.getBBox(glyph)`；
  DOM 侧量墨迹用 canvas `measureText` 的 `actualBoundingBox*`（文字基线在本地 y=0，见 `editor/help.ts::inkBox`）。
- `window.__app` / `window.__book` 运行时暴露（`src/main.ts`）供无头校验用。
- Tauri 新增插件要同改的四处见 [编辑器](docs/模块/编辑器.md)「Tauri 外壳」；其余见各模块页。
