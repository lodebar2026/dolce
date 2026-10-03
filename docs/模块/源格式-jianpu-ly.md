# 源格式：jianpu-ly（`.jly`）

上游语法见 [格式/jianpu-ly](../格式/jianpu-ly.md)（判据、词法表、三个坑）。这一页讲**代码怎么分工**、
模型怎么对、以及哪些地方是实测换来的。

## 文件与职责

| 文件 | 职责 |
|---|---|
| `src/model/fromjly.ts` | **读入**：`scanWord` / `scanMusicLine` / `isJlyMusicLine`（词法）、`syllablesOf`（歌词音节，含占位与连写）、`parseJly`（装配成 `ScoreDoc`）、`rewrapJlyText`（曲行重断） |
| `src/model/tojly.ts` | **写出**：`planJly`（歌词位置 + 圆滑线分组）、`ornamentsBefore` / `ornamentsAfter` / `chordBody` / `sustainOf`、`lyricLines`、`emitJlyOfScore`、`emitJly(doc)` |
| `src/model/jlychords.ts` | **和弦符号**两个方向的转换：LilyPond 和弦语法 ↔ 谱上印的文字（`c2.:m7/bes` ↔ `Cm7/Bb`），以及整音符分数 ↔ LilyPond 时值串 |
| `src/editor/visual/dialects/jly.ts` | **可视化编辑方言**（`DIALECT_JLY`）：顺序无关的 `scan`、规范 `printNote`、`deco`/`annotationText`/`dynamicText`、`tuplet`、`slurNesting`、`lineBreak`；`chordEdit` —— 和弦在 `chords=` 行上，按**时间线**改那一行（点一个音算出它落在第几拍，插进去，并把相邻格的时值切成两段） |
| `src/editor/formats.ts` | 适配器 `JLY`：`defaultExt ".jly"`、`caps`、`reload → host.reloadJly`、`toScoreDoc → parseJly`、`relayoutText → rewrapJlyText`、`editDialect` |
| `src/common/filetypes.ts` | `.jly` 进 `DOC_EXT` 白名单（`JLY_EXT`、`isJlyFile`） |
| `src/editor/app.ts` | `reloadJly`（解析 → 排版 → 报诊断）、`_importBytes` 的 `.jly` 分支 |
| `src/editor/formatswitch.ts` | `OriginFormat` 里加 `"jly"`、`originName` 取中文名 |
| `src/model/doc.ts` | `ScoreDoc.sourceFormat` 允许 `"jly"` |

## 模型映射

| jianpu-ly | `ScoreDoc` |
|---|---|
| `1`–`7` + `'` `,` + `#` `b` `n` | `Note.degree = { number, octaveShift, accidental }` |
| 时值字母 / 反斜杠 / 附点 | `Chord.duration = { divisions, dots }`（`SIMPLE_DIVISIONS = 48` = 四分），减时线条数 = `Chord.beams` |
| `-` | 加到 `duration` 上，并按条数挂 `Chord.sustains` |
| `0` | `Chord.rest` |
| `\|` | `Measure.barlines`（小节里已有音 = `right` 收尾线；行首 = `left` 左线） |
| `~` | `Note.tie = { start, stop }`（前一个音 `start`、这个音 `stop`） |
| `n[ … ]` | `Chord.duration.timeMod = { actual: n, normal }` |
| `L:` / `H:` | `Chord.lyrics = [{ number, text, syllabic? }]`；`""` 与 `_`/`\skip` 是**空位**（不产生 `Lyric`）；`一_三` 合成一个字 "一三" |
| `\mf`（力度） | `Chord.notations.articulations` 里的一项 —— 与 123 的 `!mf!` **同一个落点** |
| `^"文字"` | `Chord.sectionWord` —— 与 123 的 `"^渐慢"` 同一个落点 |
| `\fermata` | `Chord.notations.fermata` |
| `Fine` `DC` `DS` `Segno` `ToCoda` | `Barline.ornaments` 上的短名（`fine`/`dc`/`ds`/`hs`/`ty`）—— 与 123 的 `!fine!` 同一个落点 |
| `R4{ … }` | 小节反复：读进来按 `\repeat percent N` 的语义**展开成 N 遍真实小节**（歌词一起复制、副本换新 id）；写出一律按真实小节写 |
| `R*8` | 读：展开成 8 个整小节休止（模型里没有「N 小节休止」字段，但小节数是真实的）；写：一律写成 N 个休止小节 |
| `R{ … } A{ … }` | 反复开始/收尾 → `Barline.repeat`（`forward`/`backward`）、第二房 → `Barline.ending`（`numbers: [2]`，与 123 的 `|2 … :|` 同一个落点） |
| `\break` / `\pageBreak` | 换行/换页 → 小节末的记在**下一小节**的 `Measure.print`（`newSystem`/`newPage`）、小节中间的记在前一个和弦的 `lineBreakAfter`（与 123 的 `$`/`$$` 同一套口径） |
| `\bar ".|:"` / `\bar ":|."` | `Barline.repeat`（`forward`/`backward`）+ 小节线样式（123 的 `\|:` `:\|` 同落点） |
| `chords=c2. g:7 c` | `Chord.harmony`（`{ root, kind: "", text }`）—— 与 123 的 `"Am7"` 同一个落点；读的时候 token 的**时值**是一条时间线，落到"起点 ≤ 该时刻"的最后一个音上 |
| 页头 / `1=X` / `4/4` / `4=85` | `Song.work` / `Song.key` / `Song.time` / `Song.tempos` |
| `NextScore` / `NextPart` | 新的 `Song` / 新的 `Part` |

反向（写出）走 `jianpuInputOfDoc(doc) ?? jianpuInputOfJpw(doc)` 拿引擎输入（`JScore`），
与 `tojpw.ts` 同一套口径：**写出端不认 `ScoreDoc` 的类，只看简谱引擎输入**。

## 判据（改之前先读代码里那段注释）

1. **歌词位置 = 发音的和弦**（`isRestToken` 与 `chordBody` 同一份判据）。休止不占（LilyPond 的
   `\lyricsto` 跳过休止，连带梁的 `q0` 也跳 —— 上游自己的 `use_rest_hack` 就是为这个）；
   增时线 `-`、附点、连音 `n[ ]`、和弦 `,135'`、倚音都不额外占位（逐项实测）。
2. **缺格写 `""`**（上游自己的写法），不写就整行左移。
3. **圆滑线分两种**：真一字多音的组写 `(`（整组只有组首算一个位置），其余写 `\(`；
   而且 `(` **必须后置**在起音的数字后面 —— LilyPond 把写在音前的 `(` 算在**前一个音**头上，
   弧内到 `)` 那个音为止都不吃音节。读入端按同一条规则认（前一个 token 是音就算在它头上，
   否则算在下一个音头上）。
4. **拉丁音节一律加引号**：`4`、`s0` 这类"像时值"的字不加引号会被 LilyPond 当跳过记号；
   引号写法与裸写法画出来的坐标逐一相同。
5. **小节线必须记进模型**：谱面的小节与曲行都是从 `Measure.barlines` 长出来的。
   漏了它，整首歌会变成一个没有小节线的长行（音符与歌词挤成一团）—— 这条是踩过的坑。

## 已知缺口

- 词法**认得出但不当记号读**的写法见格式页「本版不收」；写不出的（和弦符号、多声部、
  多乐章、拉丁连字符）以 `%` 注释写进导出文件。
- 跳转裸词按**小节线**收（`Barline.ornaments`），写在小节中间的裸词位置会挪到小节线。
- `\pageBreak` 能读进模型、导到 123 是 `$$`，但**导出到 `.jly` 时会降级成 `\break`**：页末那一跳在共享的引擎输入里没带过来（`pu/slots.ts` 的页面切分按 `bySystem` 走；`jianpuinput.ts` 里已把 `pageEnds` 在两种视图都传上）。
- 可视化编辑方言没给 `measure`：谱面上不能插删小节（和弦名能改，见 `chordEdit`）。
- 「按乐句重排」用的是**出厂值**（每 4 小节一行），还没接排版尺子（`FitMeasure`）。
- `Lyric.syllabic` 只在读入方向有（写出端拿不到引擎输入里的 `syllabic`），所以拉丁连字符只报不写。

## 验证

判据一律拿**真工具**换：真 `jianpu-ly`（pipx 装的 CLI）+ 真 LilyPond，再从产出的 SVG 里读坐标。
脚本不进仓库（本项目私有回归脚本在 `../dev`），现有这些是随手放在工作区外的分析目录里：

- 歌词对位往返 200 例（源模型 ↔ 导出再读回，逐音比）；
- 随机谱面 24 ~ 48 例过**真工具**：逐音节与 SVG 坐标对位（含休止、两种圆滑线、缺格、两段词）；
- 手写 10 例（缺格 / 行首缺格 / 休止 / 两种圆滑线 / 两段词 / 汉字 / 增时线 / 和弦）；
- 读入端 9 种上游写法与真工具逐一对上；真语料 29 份往返一致；span 断言 6606/6606；
- 应用内对照：同一段谱的 `.jly` 与等价 `.123` 在**编辑器自己的排版**下逐音节一致（Playwright 读 SVG 坐标）。

数字见提交信息；判据变更时这些脚本要一起跑。
