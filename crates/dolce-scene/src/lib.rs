//! 排版的中间表示：纯数据的场景树，取代 TS 有行为的 `PageItem` 类树（`src/pagetree/`）与成书的 `DrawList`。
//!
//! 一页一棵 [`Node`] 树。节点的形（[`Shape`]）只有六种——组 / 裸项 / 路径 / 线 / 文字 / SMuFL 字——
//! 外加可选的 [`Role`]（TS 里那几个派生类：简谱数字、八度点、减时线、歌词、弧），消费者按 `Role` 分派，
//! 不再 `instanceof`。[`Identity`] 是「画的是谁」（播放高亮、点选、可视化编辑按它认），不进 SVG。
//!
//! 冻结的场景：读 TS 导出的页面树（`dev/data/ref-layout/` 的 `scene.jsonl`）、
//! 按两种方言出 SVG（[`svg`]，与 TS `outerHTML` 逐字节相同）、规范化 dump 与比对（[`dump`]）。
//! 构建期的造法与 `update` / 规范化语义在 [`build`]（L2 起）。

use dolce_geom::{Matrix33, Point, Rect};
use serde::{Deserialize, Serialize};

pub mod build;
pub mod dump;
pub mod svg;

/// 模型元素 id（`ScoreDoc` 的 `ElementId`）。
pub type ElementId = u32;

/// 只占位、不印的图元的类名（四个出口一律跳过，同 TS `INVISIBLE`）。
pub const INVISIBLE: &str = "invisible";

/// 节点的形。JSON 里按 `t` 区分（`g` 组、`i` 裸项、`p` 路径、`l` 线、`x` 文字、`s` SMuFL 字）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum Shape {
    /// `Group`（及其派生）：组的盒按子级算、规范化坐标
    #[serde(rename = "g")]
    Group,
    /// 裸 `PageItem`：只是个坐标系
    #[serde(rename = "i")]
    Item,
    #[serde(rename = "p")]
    Path(PathShape),
    #[serde(rename = "l")]
    Line(LineShape),
    #[serde(rename = "x")]
    Text(TextShape),
    /// SMuFL 字（`SmuflText`）：只用元数据里的紧包围盒，不提供字体盒
    #[serde(rename = "s")]
    Smufl(SmuflShape),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PathOp {
    M,
    L,
    C,
    Z,
}

/// 路径的一段：命令 + 坐标（`Z` 没有坐标）。JSON 里写成 `["M", x, y]`。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(from = "Vec<serde_json::Value>", into = "Vec<serde_json::Value>")]
pub struct PathSeg {
    pub op: PathOp,
    pub pts: Vec<f64>,
}

impl From<Vec<serde_json::Value>> for PathSeg {
    fn from(v: Vec<serde_json::Value>) -> Self {
        let op = match v.first().and_then(|x| x.as_str()) {
            Some("M") => PathOp::M,
            Some("L") => PathOp::L,
            Some("C") => PathOp::C,
            _ => PathOp::Z,
        };
        // JSON 里没有 NaN：TS 写成 null，读回 NaN
        let pts = v[1..].iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect();
        PathSeg { op, pts }
    }
}
impl From<PathSeg> for Vec<serde_json::Value> {
    fn from(s: PathSeg) -> Self {
        let op = match s.op {
            PathOp::M => "M",
            PathOp::L => "L",
            PathOp::C => "C",
            PathOp::Z => "Z",
        };
        let mut v = vec![serde_json::Value::from(op)];
        v.extend(s.pts.into_iter().map(serde_json::Value::from));
        v
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathShape {
    pub segs: Vec<PathSeg>,
    pub stroke_width: f64,
    pub stroke_color: f64,
    pub fill_color: f64,
    pub stroke: bool,
    pub fill: bool,
}

impl PathShape {
    /// SVG `d`（同 TS `GraphicPath.d`：每段 `op` + 坐标以空格连、段尾一个空格，`Z` 不带空格，整串去首尾空白）。
    pub fn d(&self) -> String {
        let mut s = String::new();
        for seg in &self.segs {
            if seg.op == PathOp::Z {
                s.push('Z');
                continue;
            }
            s.push(match seg.op {
                PathOp::M => 'M',
                PathOp::L => 'L',
                _ => 'C',
            });
            let pts: Vec<String> = seg.pts.iter().map(|&v| dolce_base::js::num_to_string(v)).collect();
            s.push_str(&pts.join(" "));
            s.push(' ');
        }
        dolce_base::js::trim(&s).to_string()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineShape {
    pub p0: Point,
    pub p1: Point,
    pub stroke_width: f64,
    pub stroke_color: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextShape {
    pub text: String,
    pub font: dolce_text::Font,
    /// ARGB
    pub color: f64,
    /// 逐字笔位（相对本节点 x，按码点）；None = 连排
    #[serde(default)]
    pub char_xs: Option<Vec<f64>>,
    /// 用紧包围盒而不是字体全局 ascent/descent 算盒
    #[serde(default)]
    pub ink_bound: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmuflShape {
    #[serde(flatten)]
    pub text: TextShape,
    #[serde(default)]
    pub as_path: bool,
}

/// 节点的角色：TS 里那几个页面树派生类，带上下游（导出、可视化编辑、避让）要读的字段。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k")]
pub enum Role {
    /// 简谱数字（`JpNumber`）：附点是画上去的圆，宽里另留 `augDotAdvance`；`cx` 是首字墨迹中心（`JpNumber.cx`，
    /// 导出 PPTX 按目标字体重摆数字时以它为心）
    #[serde(rename_all = "camelCase")]
    JpNumber {
        aug_dot_advance: f64,
        #[serde(default)]
        cx: f64,
    },
    /// 八度点 / 附点（`JpOctaveDot`）：实心圆，盒按解析式。附点记 `aug` = 第几个附点，挂的数字是**父组的头一个子节点**
    /// （导出 PPTX 按目标字体的数字宽重摆附点）
    JpOctaveDot {
        radius: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        aug: Option<u32>,
    },
    /// 减时线（`BeamLine`），第 `level` 层（1 起）。`ends` = 两端所接数字所在音符组在**同一父节点**里的下标
    /// （数字是那组的头一个子节点；导出 PPTX 按目标字体的数字宽把两端接回数字盒）
    BeamLine {
        level: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ends: Option<[u32; 2]>,
    },
    /// 歌词音节（`Lyric`）：前标点 / 主体 / 后标点三段宽、挤压档、段号
    Lyric { widths: [f64; 3], compress: String, verse: f64 },
    /// 圆滑线（简谱引擎 `engrave/arc.ts::Slur`）
    #[serde(rename_all = "camelCase")]
    Slur { flat_hx: f64 },
    /// 延音线（`Tie`）：连的两个和弦
    #[serde(rename_all = "camelCase")]
    Tie {
        flat_hx: f64,
        #[serde(default)]
        start_id: Option<ElementId>,
        #[serde(default)]
        end_id: Option<ElementId>,
    },
}

/// 身份标签的种类（`pagetree/identity.ts::IdentityKind`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IdentityKind {
    Note,
    Sustain,
    Barline,
    Slur,
    Syllable,
    System,
    Harmony,
    Deco,
    Annotation,
    AugDot,
    Header,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Before,
    After,
}

/// 图元的身份标签（`ItemIdentity`）：画的是谁。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Identity {
    pub kind: IdentityKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<ElementId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pass: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verse: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge: Option<Edge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measure: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub also: Option<Vec<ElementId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<ElementId>,
}

/// 场景树的一个节点。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Node {
    #[serde(flatten)]
    pub shape: Shape,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
    /// 本节点坐标系到父级（平移即 x / y）
    #[serde(default)]
    pub m: Matrix33,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
    /// 排版用的盒（本地坐标；TS `bound` getter 的值）。SMuFL 字的码位不在元数据里时为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<Rect>,
    /// 类名（有序；混排方言写进 `class`）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Identity>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sel: bool,
    /// 附带的数值数据（五线谱系统的谱表带 `top/bottom`、和弦组的 `cx`…，播放线按它画）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub k: Vec<Node>,
}

impl Node {
    pub fn is_group(&self) -> bool {
        matches!(self.shape, Shape::Group)
    }
    pub fn is_invisible(&self) -> bool {
        self.cls.iter().any(|c| c == INVISIBLE)
    }
    pub fn x(&self) -> f64 {
        self.m.translate_x()
    }
    pub fn y(&self) -> f64 {
        self.m.translate_y()
    }
    pub fn has_class(&self, c: &str) -> bool {
        self.cls.iter().any(|x| x == c)
    }
    /// 前序遍历（含自己）。
    pub fn walk<'a>(&'a self, f: &mut dyn FnMut(&'a Node)) {
        f(self);
        for c in &self.k {
            c.walk(f);
        }
    }
}

/// SVG 方言：简谱那一路（每个节点一个 `<g>`、矩阵加在 `<g>` 上、颜色取节点）与五线谱 / 混排那一路
/// （只有组出 `<g>`、矩阵加在叶子上、线与字一律黑、只递归组）。见 TS `layout/render.ts` 两个 visitor。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Jianpu,
    Mixed,
}

/// 一页。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Page {
    pub dialect: Dialect,
    /// `<svg>` 的 class（`score-page` / `score-page mixed-page`）
    pub cls: String,
    /// viewBox 宽高（简谱是 pt，五线谱是 tenths）
    pub w: f64,
    pub h: f64,
    pub root: Option<Node>,
}
