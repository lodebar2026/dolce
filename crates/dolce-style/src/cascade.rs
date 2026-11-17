//! 样式级联（照 `style/cascade.ts`）：若干层规则按序叠成一份 computed 样式表（后者覆盖前者）。
//!
//! 规则只按上下文限定（档位 / 引擎 / 分页 / 页位 / 段号）过滤；`page` / `verse` 目前只实现匹配。

use crate::sheet::{empty_sheet_value, StyleSheet};
use crate::value::{js_to_string, merge_style, strict_eq};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 上下文（`StyleContext`）：`mode` / `engine` / `paged` / `page` / `verse`，没有的维度不写。
pub type StyleContext = Map<String, Value>;

/// 一条规则：`when` 给了的每一项都要与上下文相等才生效；不给 = 恒生效。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StyleRule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<StyleContext>,
    pub set: Value,
}

pub type StyleLayer = Vec<StyleRule>;

/// 造一个上下文：`ctx(&[("mode", "original".into()), …])`。
pub fn ctx(dims: &[(&str, Value)]) -> StyleContext {
    dims.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

/// `ruleMatches`：上下文里没有的维度，带这个限定的规则不生效。
pub fn rule_matches(when: Option<&StyleContext>, ctx: &StyleContext) -> bool {
    let Some(when) = when else { return true };
    when.iter().all(|(k, v)| strict_eq(v, ctx.get(k)))
}

/// `computeStyle`：按层序、层内按规则序叠出 computed 样式表。
pub fn compute_style(layers: &[&[StyleRule]], ctx: &StyleContext) -> StyleSheet {
    let mut out = empty_sheet_value();
    for layer in layers {
        for rule in layer.iter() {
            if rule_matches(rule.when.as_ref(), ctx) {
                out = merge_style(&out, &rule.set);
            }
        }
    }
    StyleSheet(out)
}

fn when_key(when: Option<&StyleContext>) -> String {
    let Some(when) = when else { return String::new() };
    let mut keys: Vec<&String> = when.keys().collect();
    keys.sort();
    keys.iter().map(|k| format!("{k}={}", js_to_string(&when[*k]))).collect::<Vec<_>>().join(";")
}

/// `upsertRule`：**限定完全相同**的规则就地合并，否则追加。返回新数组。
pub fn upsert_rule(layer: &[StyleRule], when: Option<&StyleContext>, set: &Value) -> Vec<StyleRule> {
    let key = when_key(when);
    let mut out: Vec<StyleRule> = layer.to_vec();
    if let Some(hit) = out.iter_mut().find(|r| when_key(r.when.as_ref()) == key) {
        hit.set = merge_style(&hit.set, set);
    } else {
        out.push(StyleRule { when: when.cloned(), set: set.clone() });
    }
    out
}

/// `sanitizeLayer`：存量数据可能是任何东西，形状不对的规则丢掉。数换成 f64（见 `value::normalize`）。
pub fn sanitize_layer(v: &Value) -> Vec<StyleRule> {
    let Some(a) = v.as_array() else { return vec![] };
    a.iter()
        .filter_map(|r| {
            let o = r.as_object()?;
            let set = o.get("set")?;
            if !set.is_object() && !set.is_array() {
                return None;
            }
            let mut set = set.clone();
            crate::value::normalize(&mut set);
            let when = match o.get("when") {
                Some(Value::Object(w)) => {
                    let mut w = Value::Object(w.clone());
                    crate::value::normalize(&mut w);
                    w.as_object().cloned()
                }
                _ => None,
            };
            Some(StyleRule { when, set })
        })
        .collect()
}

/// 一层规则从 JSON 读进来（数换成 f64）。
pub fn layer_from_json(v: &Value) -> Result<Vec<StyleRule>, serde_json::Error> {
    let mut v = v.clone();
    crate::value::normalize(&mut v);
    serde_json::from_value(v)
}
