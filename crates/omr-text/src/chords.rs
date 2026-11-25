//! 和弦记号的文法：切词、覆盖率、归一、拆成根音 / 性质 / 低音。纯文本。
//!
//! 判据不依赖记号之间有空格（整行和弦常被连读成 `C#mF#mBmBm7E`）；根音必须大写（小写字母遍地都是，
//! `Coda` 的 d / a、`Verse` 的 e 一旦算根音就凭空长出和弦）。
use regex::Regex;
use std::sync::LazyLock;

static SECTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(intro|verse|chorus|pre-?chorus|bridge|coda|outro|ending|interlude|solo|fine|tag|refrain)\d*").unwrap());
static BRACKET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\[【][^\]】]*[\]】]").unwrap());
/// 中文段落名，带不带圆括号都算（基督更美副歌行首下方印的「（副歌）」）。
static CN_SECTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[(（]?\s*(副歌|主歌|前奏|间奏|尾奏|尾声|过门|引子|结束)\s*[)）]?").unwrap());
/// 单个和弦记号：根音大写 + 可选升降号（前置后置都认）+ 性质 + 扩展音数字 + sus/add + 转位低音。
/// 数字只收和弦里有的（2 4 5 6 7 9 11 13 69，0 是读成零的减号圈）：「Em3」「G#31」的 3 是和弦底下三连音的数字粘进来的（青年诗歌 200、198）。
static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[#♯b♭]?[A-G][#♯b♭]?(?:maj|min|dim|aug|sus|add|m|M)?(?:13|11|69|[0245679])?(?:sus\d*|add\d*)?(?:/[#♯b♭]?[A-G][#♯b♭]?)?").unwrap());
/// 跳转记号：字母恰好都是合法根音，切词前先抹掉。
pub static JUMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)D\s*[.,·]\s*[CS]\s*[.,·]?(?:\s*al\s*[.,·]?\s*(?:Fine|Coda))?|\bFine\b|\bTo\s*Coda\b").unwrap());
/// 调号 `1=C` 与拍号 `4/4`（连同左邻的裸根音）。
static KEY_METER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d\s*[=＝:：]\s*[#♯b♭]?[A-G]|(?:[#♯b♭]?[A-G]\s*)?\d+\s*/\s*\d+").unwrap());

fn is_sep(c: char) -> bool {
    c.is_whitespace() || "()（）:：-–—_,.·、|".contains(c)
}

/// 把 `re` 命中的每一段抹成等长（按字数）的空格，保住字的下标。
fn blank(s: &str, re: &Regex) -> String {
    re.replace_all(s, |c: &regex::Captures| " ".repeat(c[0].chars().count())).into_owned()
}

/// 段落方框词、方括号注、跳转、调号拍号抹成等长空格（和弦切词要保住字的下标）。
pub fn blank_non_chord(s: &str) -> String {
    let s = blank(s, &BRACKET);
    let s = blank(&s, &JUMP);
    let s = blank(&s, &SECTION);
    let s = blank(&s, &CN_SECTION);
    blank(&s, &KEY_METER)
}

/// 一个切出来的记号：原文、在原串里的字下标。
#[derive(Clone, Debug, PartialEq)]
pub struct Tok {
    pub tok: String,
    pub index: usize,
}

struct Scan {
    toks: Vec<Tok>,
    hit: usize,
    total: usize,
}

/// 从左到右贪心扫：吃得动就吃一个记号，吃不动跳一个字记未覆盖。`x_at(字下标)` 给了就裁决升降号归前一个还是后一个根音
/// （`D` 与 `#Fm` 连成 `D#Fm`：看升降号离哪个根音近）。
fn scan(s0: &str, x_at: Option<&dyn Fn(usize) -> f64>) -> Scan {
    let s = blank(&blank(s0, &JUMP), &KEY_METER);
    let cs: Vec<char> = s.chars().collect();
    let offs: Vec<usize> = s.char_indices().map(|(i, _)| i).chain([s.len()]).collect();
    let mut out = Scan { toks: Vec::new(), hit: 0, total: 0 };
    let mut i = 0;
    while i < cs.len() {
        if is_sep(cs[i]) {
            i += 1;
            continue;
        }
        match TOKEN.find(&s[offs[i]..]).filter(|m| !m.is_empty()) {
            Some(m) => {
                let mut n = m.as_str().chars().count();
                let end = i + n;
                if let Some(x) = x_at {
                    if n >= 2 && "#♯b♭".contains(cs[end - 1]) && cs.get(end).is_some_and(|c| ('A'..='G').contains(c)) && x(end - 1) - x(end - 2) > x(end) - x(end - 1) {
                        n -= 1;
                    }
                }
                out.toks.push(Tok { tok: cs[i..i + n].iter().collect(), index: i });
                out.hit += n;
                out.total += n;
                i += n;
                // 记号后面紧粘着的、和弦里没有的数字（连音数字）跳过，不算记号也不算残渣
                while cs.get(i).is_some_and(|c| c.is_ascii_digit()) {
                    i += 1;
                }
            }
            None => {
                out.total += 1;
                i += 1;
            }
        }
    }
    out
}

/// 一行字被和弦记号覆盖的比例与记号个数。
pub fn coverage(s: &str) -> (f64, usize) {
    let sc = scan(s, None);
    (if sc.total > 0 { sc.hit as f64 / sc.total as f64 } else { 0.0 }, sc.toks.len())
}

/// 切出一行里的和弦记号。
pub fn split_tokens(s: &str, x_at: Option<&dyn Fn(usize) -> f64>) -> Vec<Tok> {
    scan(s, x_at).toks
}

/// 按覆盖率判和弦行：两个以上记号容一点残渣；只有一个的要吃净（免得单个英文词 `Be`、`Ah` 当成和弦）。
pub fn is_chord_coverage(cov: f64, count: usize) -> bool {
    if count >= 2 {
        cov >= 0.85
    } else {
        count == 1 && cov == 1.0
    }
}

/// 整行是不是和弦 / 段落标记行（而非歌词）。
pub fn is_annotation_line(text0: &str) -> bool {
    let text = CN_SECTION.replace_all(&BRACKET.replace_all(text0, " "), " ").into_owned();
    if text.chars().any(|c| crate::chars::is_han(c) && !"或升降".contains(c)) {
        return false;
    }
    let rest: String = SECTION.replace_all(&text, " ").chars().map(|c| if "或升降".contains(c) { ' ' } else { c }).collect();
    if rest.trim().is_empty() {
        return !text0.trim().is_empty();
    }
    if !rest.chars().any(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let (cov, n) = coverage(&rest);
    is_chord_coverage(cov, n)
}

/// 整串恰好是一个和弦记号。
pub fn is_whole_chord(t: &str) -> bool {
    !t.is_empty() && TOKEN.find(t).is_some_and(|m| m.end() == t.len())
}

/// 归一：升降号折成 ASCII、性质符 `M`（非 maj）折小写、扩展词小写、去空白。
pub fn normalize(tok: &str) -> String {
    let s: String = tok.chars().filter(|c| !c.is_whitespace()).map(|c| match c {
        '♯' => '#',
        '♭' => 'b',
        c => c,
    }).collect();
    let cs: Vec<char> = s.chars().collect();
    // 根音段：可选前置升降号 + 字母 + 可选后置升降号
    let mut r = 0;
    if cs.first().is_some_and(|c| "#b".contains(*c)) {
        r += 1;
    }
    r += 1;
    if cs.get(r).is_some_and(|c| "#b".contains(*c)) {
        r += 1;
    }
    let r = r.min(cs.len());
    let (root, tail): (String, String) = (cs[..r].iter().collect(), cs[r..].iter().collect());
    let tail = if tail.starts_with('M') && !tail.to_lowercase().starts_with("maj") { format!("m{}", &tail[1..]) } else { tail };
    static EXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(maj|min|sus|add|dim|aug)").unwrap());
    format!("{root}{}", EXT.replace_all(&tail, |c: &regex::Captures| c[0].to_lowercase()))
}

/// 拆开的和弦：根音（0 = C … 6 = B）与升降、性质后缀（谱面写法，如 `m7`、`sus4`）、低音。
#[derive(Clone, Debug, PartialEq)]
pub struct Parsed {
    pub root: u8,
    pub root_alter: i8,
    pub kind: String,
    pub bass: Option<(u8, i8)>,
}

fn note(cs: &[char]) -> Option<((u8, i8), usize)> {
    let alt = |c: char| match c {
        '#' => 1,
        'b' => -1,
        _ => 0,
    };
    let mut i = 0;
    let mut a = 0;
    if cs.first().is_some_and(|&c| alt(c) != 0) {
        a = alt(cs[0]);
        i = 1;
    }
    let step = "CDEFGAB".find(*cs.get(i)?)? as u8;
    i += 1;
    if a == 0 && cs.get(i).is_some_and(|&c| alt(c) != 0) {
        a = alt(cs[i]);
        i += 1;
    }
    Some(((step, a), i))
}

/// 归一后的记号拆成根音、性质、低音。
pub fn parse(tok: &str) -> Option<Parsed> {
    let cs: Vec<char> = normalize(tok).chars().collect();
    let ((root, root_alter), n) = note(&cs)?;
    let slash = cs.iter().position(|&c| c == '/');
    let kind: String = cs[n..slash.unwrap_or(cs.len())].iter().collect();
    let bass = slash.and_then(|i| note(&cs[i + 1..])).map(|(b, _)| b);
    Some(Parsed { root, root_alter, kind, bass })
}

/// 性质后缀 → MusicXML `<kind>` 的值。
pub fn kind_xml(kind: &str) -> &'static str {
    match kind {
        "" => "major",
        "m" | "min" => "minor",
        "7" => "dominant",
        "maj7" => "major-seventh",
        "m7" | "min7" => "minor-seventh",
        "dim" => "diminished",
        "dim7" => "diminished-seventh",
        "aug" => "augmented",
        "6" => "major-sixth",
        "m6" => "minor-sixth",
        "9" => "dominant-ninth",
        "maj9" => "major-ninth",
        "m9" => "minor-ninth",
        "sus" | "sus4" => "suspended-fourth",
        "sus2" => "suspended-second",
        "5" => "power",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_on_line_and_jumps() {
        let t: Vec<String> = split_tokens("C#mF#mBmBm7E", None).into_iter().map(|t| t.tok).collect();
        assert_eq!(t, ["C#m", "F#m", "Bm", "Bm7", "E"]);
        assert!(is_annotation_line("C#mF#mBm7E"));
        assert!(is_annotation_line("Em F.C/E G"));
        assert!(!is_annotation_line("still"));
        assert!(!is_annotation_line("我的神"));
        assert!(split_tokens("D.C. al Fine", None).is_empty());
        assert!(split_tokens(&blank_non_chord("Verse 1=C 4/4"), None).is_empty());
        assert!(is_whole_chord("Bb/D") && !is_whole_chord("Be"));
    }

    #[test]
    fn sharp_goes_to_nearer_root() {
        // D 与 #Fm 隔得远：升降号归后一个
        let xs = [0.0, 50.0, 55.0, 60.0];
        let t: Vec<String> = split_tokens("D#Fm", Some(&|i| xs[i])).into_iter().map(|t| t.tok).collect();
        assert_eq!(t, ["D", "#Fm"]);
    }

    #[test]
    fn normalize_and_parse() {
        assert_eq!(normalize("CM"), "Cm");
        assert_eq!(normalize("C♯SUS4"), "C#sus4");
        assert_eq!(normalize("Cmaj7"), "Cmaj7");
        let p = parse("F#m7/C#").unwrap();
        assert_eq!((p.root, p.root_alter, p.kind.as_str(), p.bass), (3, 1, "m7", Some((0, 1))));
        assert_eq!(kind_xml("m7"), "minor-seventh");
    }
}
