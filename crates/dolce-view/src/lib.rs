//! 排版行视图（`ScoreDoc` → 一行一行的符号流，同 `src/jianpu/slots.ts`）与它所用的文本谱 AST 形状，
//! 以及由 `ScoreDoc` 拼演唱顺序 / 试听 / 断句的输入（简谱形状 `playsong` / `phrasesong`，MusicXML 形状 `playdoc` / `phrasedoc`），成书断点写回（`bookbreaks`）。

pub mod ast;
pub mod bookbreaks;
pub mod phrasesong;
pub mod playdata;
pub mod slots;
pub mod phrasedoc;
pub mod playdoc;
pub mod playsong;
