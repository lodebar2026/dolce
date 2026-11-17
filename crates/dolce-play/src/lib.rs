//! 演唱顺序、断句、试听时间轴与 MIDI（TS `score/{playorder,phrase,timeline,midi}.ts` 照搬）。
//!
//! 输入是格式无关的形状（TS 侧 `model/playdoc.ts`、`jianpu/playsong.ts`、`model/phrasedoc.ts`、`jianpu/phrasesong.ts`
//! 由 `ScoreDoc` 拼好、经 `src/engine/play.ts` 编成 JSON 过边界）；产物里引用输入对象的地方一律回下标，由 TS 侧认回对象。
//!
//! - [`playorder`]：反复、房号、D.C./D.S./Coda、`P:` 段落、逐遍演唱顺序、`.Repeat` → `PlayItem` 序列
//! - [`phrase`]：乐句断点（歌词标点 + 音乐信号 + 重复旋律，DP 选行）
//! - [`applybreaks`]：断句之后的容量补刀、并行、行首行尾收拾、排版模式阶梯、按乐句行分页
//! - [`walk`]：按演唱顺序逐遍走小节（首尾裁切、遍末与往回跳换页），投影档排版与识别歌词对照共用
//! - [`timeline`]：按演唱顺序展开的发声音符、光标锚点、节拍器、拍号调号变化点
//! - [`midi`]：标准 MIDI 文件（format 1）
//!
//! 与 TS 的口径：`Math.round` / 稳定排序 / `Map` 与 `Set` 的插入次序一律照搬（`dolce_base::js`）；
//! TS 里会抛错的输入（没有和弦的小节取时值、越界取小节）这里回 `Err`，由 TS 侧照样抛出。

pub mod applybreaks;
pub mod jppitch;
pub mod midi;
pub mod phrase;
pub mod phraseinput;
pub mod playorder;
pub mod timeline;
pub mod walk;

/// TS 那边会抛错的情形（消息只给开发者看，界面上不显示）。
#[derive(Debug, Clone, PartialEq)]
pub struct PlayError(pub String);

impl std::fmt::Display for PlayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub type PlayResult<T> = Result<T, PlayError>;

pub(crate) fn err<T>(msg: &str) -> PlayResult<T> {
    Err(PlayError(msg.to_string()))
}
