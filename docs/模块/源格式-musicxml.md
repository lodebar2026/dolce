# 源格式：MusicXML

**判据全录** → [../实现/MusicXML-导出.md](../实现/MusicXML-导出.md)

## 职责

MusicXML 双向（导入为 `ScoreDoc`；简谱档与成书经 `model/jianpuproject.ts::projectForJianpu` → `pu/slots.ts::docView` 直出（不经 123 文本），五线谱/混排由 `ScoreDoc` 建版；导出只有一份写出端 `model/toxml.ts`，见 [导出.md](导出.md)）。

`.abc` 是原生可编辑保存的源格式，读写都在 [源格式-abc家族.md](源格式-abc家族.md)（与 123 共用基类），不经 MusicXML。

## 入口

| 函数 | 文件 | 作用 |
|---|---|---|
| `layoutStaff(doc)` | `src/mixed/layout.ts` | `ScoreDoc` → `StaffLayout`（五线谱/混排的版面态，只读 `ScoreDoc` 与其表层 `xmlsurface.ts`） |
| `loadScoreDoc(xml)` | `src/model/fromxml.ts` | → `ScoreDoc`（**直通**：语义进模型，表层绑在原节点上，见 `model/xmlsurface.ts`） |
| `scoreDocToMusicXml(doc)` | `src/model/toxml.ts` | **唯一写出端**；简谱来源先经 `model/xmlproject.ts` 投影 |
| `projectForJianpu(song)` | `src/model/jianpuproject.ts` | MusicXML 形状 → 简谱形状（简谱档排版、转 123 之前） |
| `engraveScoreDoc(doc, page)` | `src/mixed/engrave.ts` | 导出的版面坐标：五线谱引擎排一遍（与屏幕同一套），坐标装进 `EngravedLayout` 交给写出端，不写进模型 |

`src/score/xmldom.ts` 是 DOM 读取小工具（`child`/`children`/`childText`），`fromxml.ts` 用。

## 吃什么吐什么

- 导入：`.xml`/`.musicxml` → `ScoreDoc`（简谱档、五线谱/混排、成书共用）
- 导出：有底本且没改过 → 原文零损耗；否则 → 唯一写出端整份重写

## 关键判据

- **全量重写不丢东西靠表层回填**：`fromxml.ts` 只读语义，模型对象绑到原节点（`xmlsurface.ts`）；`toxml.ts` 从模型写语义，
  原节点上写出端不管的属性与子节点通用回填（`toxml.ts::OWNS` 列出写出端管的）。坐标、字体、slur 贝塞尔、`<supports>`、
  `<score-instrument>` 这类因此不必逐项进模型。
  所以以前「有底本就 patch」的取舍（`.jpwabc` 装得少、重生成 = 降采样）已经退役，增量 patch 删了。
- MusicXML 形状的文档（首小节带 `attrs.divisions`）不经投影，重写逐字节稳定。
- 单音震音 `<tremolo type="single">n` 进 `Notations.tremolo`（道数），`default-x/default-y` 进 `tremoloPos`（本仓按斜线墨迹中心记：x 相对符头左缘、y 相对谱表顶线，tenths），双音震音仍按元素名留在 `ornaments`；
- 奏法记号的 `placement`（`<accent placement="below"/>`）进 `Notations.articPlacement`（按记号名），写出端原样写回；五线谱照它定上下；
  `<measure-style><multiple-rest>` 进 `MeasureAttrs.multiRest`（只记首小节，后面那几个小节照原样在）。
- **slur 的起止按小节内的时刻配，不按文档序**（`fromxml.ts::MarkSink`）：一小节里先写完谱表 1 再 `<backup>` 写谱表 2，
  钢琴跨谱表弧的止端（右手小节后半的和弦）在文档里排在起端（左手小节头的音）前面，按文档序会把这个止端配给上一条、起端留给下一条的止端，
  一整排弧全错开一个（宁静的伯利恒钢琴每小节一条，GT 与识别稿都这样写）。所以起止先攒着，小节读完按时刻排（同一时刻保持文档序：倚音弧起在倚音、止在同一时刻的主音上）再配。
  tied / tuplet 仍按文档序：tied 按栈配、和弦里几条同时起，换了序会配乱（是爱 m27、m39）；栈里有几条开着时先找同音高的那条——
  三音和弦三条延音线同时起收，只按后进先出会配成交叉的 A→D、D→A（八段锦高音笙 m74，`Mark.startNote/endNote` 错了五线谱就连错音）。
  「同号后起点顶掉前起点」原先不分谱表，两行谱同时各开一条 1 号弧
  （右手跨小节线那条、左手小节里那条，宁静 m51 / m83）是 Finale 的常见写法，同一行谱两个声部各开一条 1 号弧也是（识别稿写出端按文档序发号），
  所以顶掉只顶同谱表同声部的，止端也按同谱表同声部 → 同谱表 → 别的谱表的次序找起端。
- `.jpwabc` 的房号由 `.Repeat` 反推（`xmlproject.ts::voltasOfPlayOrder`，读 `Song.playOrder`），并自动给除最后一房外每房补 backward repeat。
- **导出的版面由五线谱引擎给**（`engraveScoreDoc`）：纸取设置、断行照简谱视图的行、坐标就是屏幕上五线谱的坐标，
  读回来走「带版面」那条路、排出来与导出前一致。以前另有一套 DOM 版面注入（A4 常量表、每行 4 小节、音符均分），已删。
  底本自带 `<defaults>` 或小节宽/`default-x` 时一字不改。
- MuseScore 兼容：有任何 `<credit>` 就不再用 `<work-title>` 生成标题 → 缺 title credit 时补一条；
  `<part-name>` 留空并 `print-object="no"`。

- **简谱档的普通小节线由投影补**（`jianpuproject.ts::projectForJianpu`）：MusicXML 的普通小节不写 `<barline>`，模型里没有右线；
  简谱这边「没有右线」是行末开口的小节，行视图（`pu/slots.ts::buildRow`）不出小节线元素。不补的话展开档与原样档都整行并成
  一两个大小节、只在双线/终止线处有线，曲中转调也只在这类线上才画得出来。投影在克隆上给每个没有右线的小节补一根普通线
  （有右线对象而样式未定的填普通线），原模型不动。
- **节奏音符（`<unpitched>`）也留着音**（`fromxml.ts`）：显示位置记 `Note.unpitched`，它的 `<tie>`、和弦里叠的第二个（钹与鼓同时）都挂在音上；
  以前 `notes` 恒为空，小钗 8 条延音线、m91 两个叠音读进来就没了，五线谱也全画在第三线。写出照显示位置写，
  只有简谱来源（没有显示位置）的才写斜线符头——以前一律写 `slash`，打击乐谱往返一趟符头全变斜线。
- **副标题与页脚只写在 `<credit>` 里的**（《八段锦》的「（民乐合奏）」、每页「《八段锦》（民乐合奏） n」），转简谱文本时
  照 `credit-type` 与位置落成 `T:` 第二行、`I:bottomcenter`（`jianpuproject.ts::headerFromCredits`，末尾页码去掉）；简谱视图同一份。

## 在谱面上编辑

没有代码区，谱面上改的是模型（`model/edit.ts`），改完经 `toxml.ts` 整份重写；索引按 DOM 节点的文档序对到隐藏代码区里的原文
（`editor/sync.ts::buildXml`）。判据见 [实现/可视化编辑](../实现/可视化编辑.md)「MusicXML：改模型」。增删音、改时值、拆并小节后整曲的版面坐标作废，改由五线谱引擎自动铺排。

## 已知限制

- `.Repeat` 的 skip/limit **不表达**（`<ending>` 只能整小节）
- 长音中间不在整拍上的和弦简谱写不出（提前到音符上，挂不下的进丢失清单）
- 简谱档里同一谱表的第二个 `<voice>` 排成并排下行（同 123 的 `&`）；第三个起、一个 part 的第二条谱表（`<staves>2`）简谱排不下
- 跨行小节未合并时会出现 `48+16` 这类时值不满的成对小节（GT 里也如此）
