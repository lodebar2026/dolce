//! 照 dev `tests/xmltree.test.ts` 搬：坏输入要报错、实体、注释、原文区间（UTF-16）、序列化转义。

use super::*;

fn kids_tags(d: &XmlDoc, id: NodeId) -> Vec<String> {
    d.tree.children(id).map(|c| d.tree.tag(c).to_string()).collect()
}

/// 原文按 UTF-16 区间切
fn slice16(s: &str, a: i64, b: i64) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    String::from_utf16(&u[a as usize..b as usize]).unwrap()
}

#[test]
fn prolog_doctype_comment_pi_cdata() {
    let src = "\u{feff}<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE score-partwise PUBLIC \"-//Recordare//DTD MusicXML 4.0 Partwise//EN\" \"http://www.musicxml.org/dtds/partwise.dtd\">\n<!-- 头注 -->\n<a x='1' y=\"&lt;&amp;&#x4E2D;&#25991;\"><!--内--><b>甲<![CDATA[<乙>]]></b><?pi 丙?><c/></a>\n";
    let d = parse(src).unwrap();
    let a = d.root;
    assert_eq!(d.tree.tag(a), "a");
    assert_eq!(d.tree.get_attribute(a, "y"), Some("<&中文"));
    assert_eq!(kids_tags(&d, a), ["b", "c"]);
    assert_eq!(d.tree.text_content(a), "甲<乙>");
    assert!(d.prolog.starts_with("<?xml"));
    let want = src[3..].replace("x='1' y=\"&lt;&amp;&#x4E2D;&#25991;\"", "x=\"1\" y=\"&lt;&amp;中文\"");
    assert_eq!(d.serialize(), want);
}

#[test]
fn internal_subset_entities() {
    let d = parse("<!DOCTYPE a [ <!ENTITY who \"张三\"> <!ELEMENT a ANY> ]><a>&who;</a>").unwrap();
    assert_eq!(d.tree.text_content(d.root), "张三");
    // 先声明的算数
    let d = parse("<!DOCTYPE a [<!ENTITY x 'A'><!ENTITY x 'B'>]><a>&x;</a>").unwrap();
    assert_eq!(d.tree.text_content(d.root), "A");
}

#[test]
fn newline_normalisation() {
    let d = parse("<a t=\"x\r\ny\tz\">1\r\n2\r3</a>").unwrap();
    assert_eq!(d.tree.text_content(d.root), "1\n2\n3");
    assert_eq!(d.tree.get_attribute(d.root, "t"), Some("x y z"));
}

#[test]
fn bad_input_errors() {
    for (what, src) in [
        ("标签不配对", "<a><b></a></b>"),
        ("没闭合", "<a><b></b>"),
        ("多个根", "<a/><b/>"),
        ("根后有文字", "<a/>x"),
        ("根前有文字", "x<a/>"),
        ("属性没引号", "<a x=1/>"),
        ("属性重名", "<a x=\"1\" x=\"2\"/>"),
        ("属性值里有 <", "<a x=\"<\"/>"),
        ("不认得的实体", "<a>&nbsp;</a>"),
        ("裸 &", "<a>a & b</a>"),
        ("属性间缺空白", "<a x=\"1\"y=\"2\"/>"),
        ("空文档", "  "),
        ("空串", ""),
    ] {
        assert!(parse(src).is_err(), "{what} 要报错");
    }
}

#[test]
fn error_positions_are_utf16() {
    // 「𝄞」占两个码元：报错位置按 UTF-16 数
    let e = parse("<a>𝄞&nbsp;</a>").unwrap_err();
    assert_eq!(e.message, "不认得的实体 &nbsp;");
    assert_eq!(e.at, 5);
    assert_eq!(e.to_string(), "不认得的实体 &nbsp; @5");
    let e = parse("<a>中</b>").unwrap_err();
    assert_eq!(e.message, "</b> 与 <a> 不配对");
    assert_eq!(e.at, 4);
}

#[test]
fn spans() {
    let src = "<?xml version=\"1.0\"?>\n<m><note a=\"1\"><x/></note ><note/></m>";
    let d = parse(src).unwrap();
    let m = d.root;
    let ks: Vec<NodeId> = d.tree.children(m).collect();
    let (n1, n2) = (ks[0], ks[1]);
    assert_eq!(&src[d.tree.start(n1) as usize..d.tree.end(n1) as usize], "<note a=\"1\"><x/></note >");
    assert_eq!(&src[d.tree.start(n2) as usize..d.tree.end(n2) as usize], "<note/>");
    assert_eq!(&src[d.tree.start(m) as usize..d.tree.end(m) as usize], &src[src.find("<m>").unwrap()..]);
    // 非 BMP 字符之后的区间按 UTF-16
    let src = "<m>𝄞中<n>甲</n></m>";
    let d = parse(src).unwrap();
    let n = d.tree.first_element_child(d.root).unwrap();
    assert_eq!(d.tree.start(n), 6);
    assert_eq!(slice16(src, d.tree.start(n), d.tree.end(n)), "<n>甲</n>");
}

#[test]
fn comment_tags_do_not_count() {
    let src = "<m><!-- <note> --><note>1</note></m>";
    let d = parse(src).unwrap();
    let n = d.tree.first_element_child(d.root).unwrap();
    assert_eq!(&src[d.tree.start(n) as usize..d.tree.end(n) as usize], "<note>1</note>");
}

#[test]
fn clones_have_no_span() {
    let mut d = parse("<a><b/></a>").unwrap();
    let b = d.tree.first_element_child(d.root).unwrap();
    let c = d.tree.clone_node(b);
    assert_eq!(d.tree.start(c), -1);
    assert_eq!(d.tree.serialize(c), "<b/>");
}

#[test]
fn attributes_keep_order() {
    let mut d = parse("<a x=\"1\" y=\"2\" z=\"3\"/>").unwrap();
    let a = d.root;
    d.tree.set_attribute(a, "y", "\"");
    d.tree.remove_attribute(a, "x");
    d.tree.set_attribute(a, "w", "&");
    assert_eq!(d.tree.serialize(a), "<a y=\"&quot;\" z=\"3\" w=\"&amp;\"/>");
}

#[test]
fn append_moves_and_remove() {
    let mut d = parse("<a><b><c/></b><d/></a>").unwrap();
    let a = d.root;
    let ks: Vec<NodeId> = d.tree.children(a).collect();
    let (b, dd) = (ks[0], ks[1]);
    d.tree.append_child(b, dd);
    assert_eq!(d.tree.serialize(a), "<a><b><c/><d/></b></a>");
    let c = d.tree.first_element_child(b).unwrap();
    d.tree.remove(c);
    assert_eq!(d.tree.serialize(a), "<a><b><d/></b></a>");
    assert_eq!(d.tree.parent(dd), Some(b));
}

#[test]
fn insert_before() {
    let mut d = parse("<a><b/><c/></a>").unwrap();
    let a = d.root;
    let c = d.tree.children(a).nth(1).unwrap();
    let x = d.tree.create_element("x");
    d.tree.insert_before(a, x, Some(c));
    let t = d.tree.create_text(TextKind::Text, "t");
    d.tree.insert_before(a, t, None);
    assert_eq!(d.tree.serialize(a), "<a><b/><x/><c/>t</a>");
}

#[test]
fn text_escaping() {
    let d = parse("<a>1 &gt; 0 &amp;&amp; 2 &lt; 3<!-- x&y --></a>").unwrap();
    assert_eq!(d.tree.text_content(d.root), "1 > 0 && 2 < 3");
    assert_eq!(d.tree.serialize(d.root), "<a>1 &gt; 0 &amp;&amp; 2 &lt; 3<!-- x&y --></a>");
    // 控制字符剔掉
    let mut t = Tree::new();
    let e = t.h("a", &[("k", Some("\u{1}v")), ("skip", None)], ["x\u{b}y"]);
    assert_eq!(t.serialize(e), "<a k=\"v\">xy</a>");
}

#[test]
fn by_tag_name_document_order() {
    let d = parse("<a><b i='1'><b i='2'/></b><c><b i='3'/></c></a>").unwrap();
    let got: Vec<&str> = d.get_elements_by_tag_name("b").iter().map(|&b| d.tree.get_attribute(b, "i").unwrap()).collect();
    assert_eq!(got, ["1", "2", "3"]);
    assert_eq!(d.get_elements_by_tag_name("a"), vec![d.root]);
}

#[test]
fn import_from_other_tree() {
    let src = parse("<a><b x='1'>t</b></a>").unwrap();
    let mut t = Tree::new();
    let b = src.tree.first_element_child(src.root).unwrap();
    let c = t.import_node(&src.tree, b);
    let w = t.h::<Kid>("w", &[], [c.into()]);
    assert_eq!(t.serialize(w), "<w><b x=\"1\">t</b></w>");
}

#[test]
fn char_refs() {
    let d = parse("<a>&#x1D11E;&#65;&#0x41;</a>").unwrap_err();
    // `&#0x41;`：e = "#0x41"，e[1] 不是 x，/^\d+$/ 不过 → 坏的字符引用
    assert!(d.message.starts_with("坏的字符引用"));
    let d = parse("<a>&#x1D11E;&#65;&#x0x41;</a>").unwrap();
    // `&#x0x41;`：parseInt("0x41", 16) 认 0x 前缀 = 65（同 JS）
    assert_eq!(d.tree.text_content(d.root), "𝄞AA");
    assert!(parse("<a>&#x110000;</a>").is_err());
    assert!(parse("<a>&#X41;</a>").is_err());
}
