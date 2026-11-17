//! 样式表（照 `style/sheet.ts`）：一份谱「长什么样」的唯一描述。尺子都由适配器从这里取值。
//!
//! 形状对着 CSS：角色（选择器）→ 声明块。样式表是动态形状（`.ss`、内置主题、用户层 JSON 叠出来的），
//! 这里包一层 `Value`，读法照 JS 的属性访问（缺 = undefined）。

use serde_json::{json, Map, Value};

/// 版面角色（`StyleRole`），顺序同 TS 的 `STYLE_ROLES`。
pub const STYLE_ROLES: [&str; 20] = [
    "title", "songNumber", "category", "credit", "keyMeter", "note", "tuplet", "verseNum", "chord", "lyric", "lyric2", "sectionWord", "story",
    "toc", "tocHeading", "tocSub", "frontTitle", "header", "footer", "smufl",
];

/// 只有歌本模板用的角色（`TemplateRole`）。
pub const TEMPLATE_ROLES: [&str; 7] = ["titleAlt", "subtitle", "scripture", "scriptureRef", "rights", "relatedScriptures", "tags"];

pub fn is_style_role(r: &str) -> bool {
    STYLE_ROLES.contains(&r)
}

/// 合法角色名（`STYLE_ROLES` + `TEMPLATE_ROLES`）。
pub fn is_known_role(r: &str) -> bool {
    is_style_role(r) || TEMPLATE_ROLES.contains(&r)
}

/// `emptySheet()`。
pub fn empty_sheet_value() -> Value {
    json!({ "roles": {}, "page": {}, "jianpu": {}, "staff": {} })
}

/// JS 的真值（`!v` 的反面）。
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// 一份 computed 样式表（`StyleSheet`）。
#[derive(Clone, Debug, PartialEq)]
pub struct StyleSheet(pub Value);

impl Default for StyleSheet {
    fn default() -> Self {
        StyleSheet(empty_sheet_value())
    }
}

impl StyleSheet {
    pub fn value(&self) -> &Value {
        &self.0
    }
    fn get(&self, k: &str) -> Option<&Value> {
        self.0.get(k)
    }
    /// `sheet.roles`
    pub fn roles(&self) -> Option<&Value> {
        self.get("roles")
    }
    /// `sheet.roles[role]`
    pub fn role(&self, role: &str) -> Option<&Value> {
        self.roles()?.get(role)
    }
    /// `sheet.roles[role]?.<prop>`
    pub fn role_prop(&self, role: &str, prop: &str) -> Option<&Value> {
        self.role(role)?.get(prop)
    }
    /// `sheet.page`（缺按空对象）
    pub fn page(&self) -> &Value {
        static EMPTY: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        self.get("page").unwrap_or_else(|| EMPTY.get_or_init(|| Value::Object(Map::new())))
    }
    /// `sheet.jianpu.preset`
    pub fn jianpu_preset(&self) -> Option<&Value> {
        self.get("jianpu")?.get("preset")
    }
    /// `sheet.jianpu.overrides`
    pub fn jianpu_overrides(&self) -> Option<&Map<String, Value>> {
        self.get("jianpu")?.get("overrides")?.as_object()
    }
    /// `sheet.staff`
    pub fn staff(&self) -> Option<&Value> {
        self.get("staff")
    }
    pub fn staff_overrides(&self) -> Option<&Map<String, Value>> {
        self.staff()?.get("overrides")?.as_object()
    }
    /// `sheet.break?.overrides`
    pub fn break_overrides(&self) -> Option<&Map<String, Value>> {
        self.get("break")?.get("overrides")?.as_object()
    }
    /// `sheet.book`
    pub fn book(&self) -> Option<&Value> {
        self.get("book")
    }
    /// `sheet.template`
    pub fn template(&self) -> Option<&Value> {
        self.get("template")
    }
    /// `sheet.template?.fonts?.[name]`
    pub fn template_font(&self, name: &str) -> Option<&Value> {
        self.template()?.get("fonts")?.get(name)
    }
    /// `sheet.template?.regions?.[name]`
    pub fn region(&self, name: &str) -> Option<&Value> {
        self.template()?.get("regions")?.get(name)
    }
}
