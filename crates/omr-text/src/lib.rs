//! 两条路线共用的文字处理（纯文本与纯几何，不碰像素、不调 OCR）：
//!
//! - [`chars`]：字的种类（汉字 / 拉丁 / 数字 / 标点）
//! - [`chords`]：和弦记号文法（切词、覆盖率、归一、拆成根音 / 性质 / 低音）
//! - [`header`]：页眉各行的分类（标题 / 副标题 / 词 / 曲 / 版权 / 书眉）
//! - [`spaces`]：按空白列补词间空格
//! - [`lyrics`]：歌词行切成音节、段号、标点归属、对到音上
//! - [`words`]：速度与节拍器、跳转、力度的词表与判据
pub mod chars;
pub mod chords;
pub mod ensyllable;
pub mod header;
pub mod lyrics;
pub mod spaces;
pub mod words;

/// 一行字里的一个字：字、左右缘（所在坐标系的 x）。
#[derive(Clone, Debug, PartialEq)]
pub struct Ch {
    pub ch: char,
    pub x0: f64,
    pub x1: f64,
}

impl Ch {
    pub fn cx(&self) -> f64 {
        (self.x0 + self.x1) / 2.0
    }
}

/// 一行字：字串与逐字位置、行框 `(x, y, w, h)`。
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub chars: Vec<Ch>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Line {
    pub fn text(&self) -> String {
        self.chars.iter().map(|c| c.ch).collect()
    }
    pub fn cx(&self) -> f64 {
        self.x + self.w / 2.0
    }
    pub fn cy(&self) -> f64 {
        self.y + self.h / 2.0
    }
}
