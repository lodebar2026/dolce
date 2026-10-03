# 源格式：`.jpwabc`

**格式规范与语料实证** → [../格式/jpwabc.md](../格式/jpwabc.md)（段结构、字段、音乐体、`.Repeat`、11 项不支持）

## 职责

JP-Word `.jpwabc` 的分段、词法语法解析，`.jpwabc` → `ScoreDoc`（直出，带源偏移），`ScoreDoc` → `.jpwabc`。谱面经 `model/jianpuinput.ts::jianpuInputOfJpw` 进简谱引擎。

## 入口

| 函数 | 文件 | 作用 |
|---|---|---|
| `JpwFile.fromString(s)` | `src/jpword/jpwfile.ts` | 文本 → 分段（失败返回 null） |
| `lexVoice(text)` | `src/jpword/lex.ts` | `.Voice` 正文 → token 序列（含空白/注释，带偏移与行列） |
| `parseVoiceText(text)` | `src/jpword/parse.ts` | 去掉空白/注释的 token 序列；落单 `[` `]` 返回 null |
| `jpwToScoreDoc(f)` | `src/model/fromjpw.ts` | `JpwFile` → `ScoreDoc`（音符/小节线带 `SourceSpan`）。谱面、试听、转 123/ABC、导出、能力表、双向定位索引都走它 |
| `jianpuInputOfJpw(doc)` | `src/model/jianpuinput.ts` | `ScoreDoc` → 简谱引擎输入（按原文小节；小节中间的 `$` 照原位换行） |
| `emitJpwabc(doc)` | `src/model/tojpw.ts` | `ScoreDoc` → `.jpwabc` 文本（只写第一声部）。写出端 `writeJpwabc` 只经输入接口读谱 |
| `TokenData` | `src/jpword/tokens.ts` | 整份文件的行级分词，**仅供语法高亮**（`.Voice` 段复用 `lexVoice`） |

`.Voice` 正文只是一串平铺的 token（音符、小节线、换行、字符串、拍号、前奏括号），没有嵌套结构，
所以只有词法、没有语法树；音符内部的拆解在 `fromjpw.ts::readNote` 按 token 文本再做。词法规则见
[../格式/jpwabc.md](../格式/jpwabc.md)「4. 音乐体」的词法表。

## 吃什么吐什么

```
.jpwabc 文本（UTF-16LE+BOM 或 UTF-8）
  → JpwFile（TitleSection / VoiceSection / WordsSection / RepeatSection / LayoutSection）
  → .Voice token 序列（lex.ts）
  → ScoreDoc（fromjpw.ts：先切「源文小节」、歌词按它落点，再落成模型小节）
  ├→ jianpuInputOfJpw → ScorePainter（原样 / 展开），和弦带元素 id
  ├→ playSourceOfSong → 试听 / MIDI
  └→ emit123 / emitAbc / scoreDocToMusicXml / emitJpwabc
```

## 关键判据

- `)` 二义、无点「1」的绝对音高、`[|]` 必须照写：规则与反例见 [规范](../格式/jpwabc.md) §4。
- **曲首就写 `|:`** 有专门处理：不能另开空小节，否则歌词整体错后一小节。
  `|:|` 连写在源文小节里是一个空小节，落模型时并进下一小节左线（160、D01、J14）。**歌词落点不数它**（`assignLyrics`、`relayout.ts::anchorTable`）：
  写出端按模型小节数本来就不含它，读入端数了的话 `W1@1,2` 落空、词整体早一格（J14 第一个字挂到了休止上）。
- **`$` 写在小节中间**（弱起谱的乐句尾，500 首里 300 份有）：模型里小节级换行照「这一小节之后」记一份，
  另在前一个和弦上记 `Chord.lineBreakAfter`，简谱引擎据此原位换行；`$` 与小节线的先后（`$ |` / `| $`）不区分，换行一律落在小节线之后。
- **往返三样用词法里已有的 token**（不扩语法，原版 JP-Word 读到会忽略、不报错）：曲中**转拍号**写 `4/4`、
  **转调**写 `"1=G"`（同步更新调号状态，否则转调后半首音高全错）、**倚音**写 `{6,}`。
- `fromjpw` **不填绝对音高**（`.jpwabc` 只有度数），导出 MusicXML 由投影层按度数 + 调号推。
- **歌词段锚点 `W2@m,n` 的小节序号**：只有小节**中间**的换行才算开出一个小节，小节末的不算——读入端（`assignLyrics`）
  与写出端（`tojpw.ts::LyricProcessor`）必须同口径，否则多段歌词起点在第一行之后错位。
- **`jpToStep` 按调号拼写**，不按 fifths：否则 `1=#C`/`1=bD`/`1=#F`/`1=bG` 四个调整首排不出来。
- **按乐句重排只挪 `$`**（`model/relayout.ts::relayoutJpwabcText`）：`.jpwabc` 是分节文件，
  整份按 `emitJpwabc` 重出会把写出端装不下的东西（样式、`.Layout` 的分页描述）一并抹掉；
  歌词在 `.Words` 里按小节/音符号锚定、与行结构无关，所以只重切 `.Voice` 的行就够。
  `.Layout` 里按行号记的 `BreakPoints` 跟着行结构作废，重排时去掉（换页改由 `$(true,0,0,true)` 原位表达）。

## 已知限制

- 表达力边界见 [规范](../格式/jpwabc.md) §9；`{C:…}` 读入时剥掉、`::`/`:|:` 读成左右都反复的线（§8，夹具 `jpw-fixture-check.mjs`）
- 写出端不写房号与反复记号（分遍经 `.Repeat` 表达）
- `jpwToScoreDoc` 不读 `SubTitle` 与文字型 `Expression`（「热烈欢快地」），多于音符数的歌词音节在 `assignLyrics` 截掉：
  这些不进模型，谱面不画、简繁转换也不转（语料里 3 首有 `SubTitle`，2 首有多出的歌词行）

## 词法器

`lex.ts` 忠实复刻原 JP-Word 的词法定义（原为 ANTLR 文法，已改手写、去掉依赖）：每条规则一个 sticky 正则，
在当前位置全部试一遍，**取最长匹配，等长按规则先后**。几处要靠这条规矩才切得对：

- 单独的 `(` 是前奏开始，`(1` 是带弧起的音符（长者胜）；单独的 `)` 等长时归前奏结束（规则在前）。
- `[|]` 是小节线，`[135]` 起头的是和弦音符，`|[1.` 是带房号的小节线。
- `3/4` 是拍号而不是音符 `3`（长者胜）。

改规则时，正则里同一 token 的各分支要**长的写在前**（JS 正则是有序选择、不保证最长）。
与原实现的唯一差别在出错恢复：哪条规则都认不出的字符，这里只跳过 1 个；原实现会连同已读进的前缀一起跳过。
两者都不报错、静默丢弃，真实语料 582 段 `.Voice` 无一例触发。

## 与原 Kotlin 的对应

`jpwfile.kt→jpword/jpwfile.ts`、`jpw.kt→model/fromjpw.ts`（读源文那一步）由原 Kotlin/JVM 桌面版（不在本仓库）近乎逐行翻译而来。
