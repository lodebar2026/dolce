//! 字体：定位、解析、整形、字形度量、合成粗斜的判定在 `dolce_text::fontfile`（与 Linux 的系统量字共用），这里再导出；
//! 本模块只加 PDF 那部分——krilla 字体对象与嵌入可行性的判定（[`PdfFace`]）。
//!
//! 一份 [`FontBook`] 是一个 fontdb 库加字节缓存：桌面 / 命令行装系统字体（`system` 特性），
//! wasm 只装宿主给的字节（本地字体访问授权拿到的、随包的 Bravura）。族名的展开（泛称、标准字体）与量字同一份
//! （`dolce_text::css_families`），所以 PDF 选中的字体与排版量字时用的是同一族。
//!
//! **嵌不了退转曲**的判法（L7 样本验证定的，见 `probe`）：一个字体面第一次要嵌时，先单独拿它出一份只有几个字的 PDF；
//! krilla 建不出字体对象（`Font::new` 返回空：表坏、只有位图）或写出时报字体错（子集化失败）就记成**转曲**，
//! 之后这一面的字一律画轮廓、另加不可见的文字层保住可搜。整份写出时 krilla 仍报某字体错（子集不同触发的），
//! 写出端把它补记成转曲后重写一遍（见 `pdf::finish_with_retry`）。

use std::cell::RefCell;
use std::sync::Arc;

pub use dolce_text::fontfile::*;
pub use dolce_text::Platform;

/// 挂在字体面上的 PDF 缓存（[`Face::ext`]）
#[derive(Default)]
struct PdfState {
    font: RefCell<Option<Option<krilla::text::Font>>>,
    /// 嵌入探过的结果：Some(true) 能嵌、Some(false) 转曲
    embeddable: RefCell<Option<bool>>,
}

fn pdf_state(face: &Face) -> &PdfState {
    face.ext.get_or_init(|| Box::new(PdfState::default())).downcast_ref::<PdfState>().expect("Face::ext 只由导出挂 PdfState")
}

/// 字体面的 PDF 那部分。
pub trait PdfFace {
    /// krilla 的字体对象（建不出为 None）
    fn pdf_font(&self) -> Option<krilla::text::Font>;
    /// 能不能嵌（第一次问时试嵌一次，见模块注释）
    fn embeddable(&self) -> bool;
    /// 写出时 krilla 报了这个字体的错：以后转曲
    fn mark_outline_only(&self);
}

impl PdfFace for Face {
    fn pdf_font(&self) -> Option<krilla::text::Font> {
        let st = pdf_state(self);
        if let Some(f) = &*st.font.borrow() {
            return f.clone();
        }
        let f = if self.outlines == Outlines::Bitmap {
            None
        } else {
            let coords: Vec<(krilla::text::Tag, f32)> = self.coords.iter().map(|(t, v)| (krilla::text::Tag::new(t), *v)).collect();
            krilla::text::Font::new_variable(krilla::Data::from(self.data.clone()), self.index, &coords)
        };
        *st.font.borrow_mut() = Some(f.clone());
        f
    }

    fn embeddable(&self) -> bool {
        let st = pdf_state(self);
        if let Some(v) = *st.embeddable.borrow() {
            return v;
        }
        let v = self.pdf_font().is_some_and(|f| crate::pdf::trial_embed(self, f));
        *st.embeddable.borrow_mut() = Some(v);
        v
    }

    fn mark_outline_only(&self) {
        *pdf_state(self).embeddable.borrow_mut() = Some(false);
    }
}

/// krilla 报错里的字体对象 → 是哪个面
pub fn face_by_pdf_font(book: &FontBook, font: &krilla::text::Font) -> Option<Arc<Face>> {
    book.loaded().into_iter().find(|f| f.pdf_font().as_ref() == Some(font))
}
