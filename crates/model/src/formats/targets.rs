//! 输出格式表：同一份 `ScoreDoc` 能写成哪几种格式，各自的显示名、扩展名、写出端与落盘编码。
//! 与编辑器的转换目标表（TS `convert/targets.ts`，加上 MusicXML）同一份口径；命令行 `dolce`（`dolce-cli`）与歌本切分按它出各格式。

use std::borrow::Cow;

use crate::doc::ScoreDoc;
use crate::pagemeta::with_page_meta;
use crate::toxml::{score_doc_to_music_xml, ToXmlOptions};
use crate::xmlsurface::Surface;

use crate::formats::abc::emit::{emit_123, emit_abc, emit_jcx};
use crate::formats::capability::TargetFormat;
use crate::formats::fanqie::dialect::Dialect;
use crate::formats::fanqie::emit::emit_fanqie;
use crate::formats::jcxcodec::encode_jcx;
use crate::formats::jly::emit_jly;
use crate::formats::jpw::input::emit_jpwabc;

/// 顺序即帮助里列的顺序
pub const OUT_FORMATS: [TargetFormat; 8] = [
    TargetFormat::MusicXml,
    TargetFormat::J123,
    TargetFormat::Jpwabc,
    TargetFormat::Abc,
    TargetFormat::Tomato,
    TargetFormat::Shige,
    TargetFormat::Jly,
    TargetFormat::Jcx,
];

/// 写成一种格式的结果：原文（写 stdout 用）与落盘字节
pub struct Encoded {
    pub text: String,
    pub bytes: Vec<u8>,
}

/// 写出端报的消息键 → 中文（命令行只出中文；编辑器那边走 `t()`）
pub fn message_zh(key: &str) -> Cow<'_, str> {
    Cow::Borrowed(match key {
        "noLines" | "err.noLines" => "没有可写出的曲行",
        "err.noSong" => "这份文档里没有曲子",
        "err.xmlParse" => "MusicXML 无法解析",
        _ => return Cow::Borrowed(key),
    })
}

impl TargetFormat {
    pub fn id(self) -> &'static str {
        match self {
            TargetFormat::J123 => "123",
            TargetFormat::Abc => "abc",
            TargetFormat::Jpwabc => "jpwabc",
            TargetFormat::Tomato => "tomato",
            TargetFormat::Shige => "shige",
            TargetFormat::Jly => "jly",
            TargetFormat::Jcx => "jcx",
            TargetFormat::MusicXml => "musicxml",
        }
    }

    /// 显示名（同编辑器中文界面的 `fmt.target.*`）
    pub fn label(self) -> &'static str {
        match self {
            TargetFormat::J123 => "简谱 123",
            TargetFormat::Abc => "ABC",
            TargetFormat::Jpwabc => "简谱 JPWABC",
            TargetFormat::Tomato => "番茄简谱",
            TargetFormat::Shige => "诗歌本文本谱",
            TargetFormat::Jly => "jianpu-ly 文本（.jly）",
            TargetFormat::Jcx => "Muse 简谱（.jcx）",
            TargetFormat::MusicXml => "MusicXML",
        }
    }

    /// 落盘扩展名（与编辑器存盘同一份；文本谱两种方言都存 `.jps`）
    pub fn ext(self) -> &'static str {
        match self {
            TargetFormat::J123 => ".123",
            TargetFormat::Abc => ".abc",
            TargetFormat::Jpwabc => ".jpwabc",
            TargetFormat::Tomato | TargetFormat::Shige => ".jps",
            TargetFormat::Jly => ".jly",
            TargetFormat::Jcx => ".jcx",
            TargetFormat::MusicXml => ".musicxml",
        }
    }

    /// 写成文本。`surface`：MusicXML 读进来的表层（123 / ABC 把纸写成 `I:meta page …`，转过去再打开纸不丢）。
    /// 出错回消息键（[`message_zh`] 翻成中文）
    pub fn emit(self, doc: &ScoreDoc, surface: Option<&Surface>) -> Result<String, String> {
        Ok(match self {
            TargetFormat::J123 => emit_123(&with_page_meta(doc, surface)),
            TargetFormat::Abc => emit_abc(&with_page_meta(doc, surface)),
            TargetFormat::Jpwabc => emit_jpwabc(doc, 0)?.ok_or_else(|| "err.noLines".to_string())?,
            TargetFormat::Tomato => emit_fanqie(doc, Dialect::Tomato),
            TargetFormat::Shige => emit_fanqie(doc, Dialect::Shige),
            TargetFormat::Jly => emit_jly(doc)?.text,
            TargetFormat::Jcx => emit_jcx(doc),
            TargetFormat::MusicXml => score_doc_to_music_xml(doc, surface, &ToXmlOptions::default()).map_err(|e| e.key)?,
        })
    }

    /// 原文 → 落盘字节：`.jpwabc` 是 UTF-16LE 带 BOM、`.jcx` 是 `%MUSE2` + GBK，其余 UTF-8
    pub fn encode(self, text: String) -> Encoded {
        let bytes = match self {
            TargetFormat::Jpwabc => {
                let mut b = vec![0xff, 0xfe];
                b.extend(text.encode_utf16().flat_map(|u| u.to_le_bytes()));
                b
            }
            TargetFormat::Jcx => encode_jcx(&text).0,
            _ => text.clone().into_bytes(),
        };
        Encoded { text, bytes }
    }

    /// 写成文本再编码
    pub fn write(self, doc: &ScoreDoc, surface: Option<&Surface>) -> Result<Encoded, String> {
        self.emit(doc, surface).map(|t| self.encode(t))
    }
}

/// 读进来的 MusicXML（五线谱识别的产物）→ 指定格式。写 MusicXML 时原文照出、只去掉识别 id（那是编辑器核对用的）
pub fn write_music_xml_as(format: TargetFormat, xml: &str) -> Result<Encoded, String> {
    if format == TargetFormat::MusicXml {
        return Ok(format.encode(strip_omr_ids(xml)));
    }
    let mut l = crate::fromxml::load_score_doc(xml).map_err(|e| e.key)?;
    l.doc.source = None;
    format.write(&l.doc, Some(&l.surface))
}

/// 去掉元素上的识别 id（` id="omr…数字"`）
pub fn strip_omr_ids(xml: &str) -> String {
    const PAT: &str = " id=\"omr";
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(p) = rest.find(PAT) {
        out.push_str(&rest[..p]);
        let tail = &rest[p + PAT.len()..];
        let letters = tail.bytes().take_while(u8::is_ascii_alphabetic).count();
        let digits = tail[letters..].bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && tail.as_bytes().get(letters + digits) == Some(&b'"') {
            rest = &tail[letters + digits + 1..];
        } else {
            out.push_str(PAT);
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ids() {
        assert_eq!(strip_omr_ids(r#"<note id="omrN12"><x id="omr3"/><y id="omrA"/>"#), r#"<note><x/><y id="omrA"/>"#);
    }
}
