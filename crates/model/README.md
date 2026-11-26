# dolce-model

> Score model and format layer of Dolce (jianpu / staff notation editor): `ScoreDoc`, MusicXML I/O, ABC family, text notation, jpwabc, jianpu-ly, MIDI.

悦谱 Dolce 的**模型与格式层**，排版、识别、命令行都建在它上面。无平台依赖，能编到 wasm。

## 内容

- 根上：语义模型 `ScoreDoc`（`doc`）、MusicXML 读入（`fromxml::load_score_doc`，带表层 `xmlsurface::Surface`）与唯一写出端（`toxml::score_doc_to_music_xml`）、投影、编辑。
- `formats`：各源格式读写——123 / ABC / jcx（ABC 家族）、文本谱（番茄 / 诗歌本）、`.jpwabc`、jianpu-ly、MIDI 导入；格式能力表与输出格式表（`capability::TargetFormat`）。
- `play`：演唱顺序、断句、时间轴、标准 MIDI 写出（`play::midi::to_midi`）。
- `view`：排版行视图、断句与试听输入（`view::playsong::play_source_of`）、双向定位建表。
- `base`：JS 数值口径、分数、UTF-16 区间、几何。

## 特性

- `hanconv-dict`：OpenCC 简繁词表引擎（词表 Apache-2.0）。
- `ts`：给 TypeScript 门面导出类型（ts-rs）。

## 链接

- 项目主页：<https://lodebar2026.github.io/dolce/>
- 源代码：<https://github.com/lodebar2026/dolce>（分层与各 crate 的关系见 [docs/架构.md](https://github.com/lodebar2026/dolce/blob/main/docs/架构.md)「目录」）

## 许可

MIT；`hanconv-dict` 带的 OpenCC 词表为 Apache-2.0（故整体标 `MIT AND Apache-2.0`）。
