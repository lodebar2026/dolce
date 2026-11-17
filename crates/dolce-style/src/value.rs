//! 样式表的动态值：样式规则来自 `.ss` 解析、内置主题与用户层（localStorage 里的 JSON），形状由 JS 对象语义定，
//! 这里用 `serde_json::Value`（键保插入序）承载，照 JS 的口径做合并、相等、转字符串与 `JSON.stringify`。
//!
//! 数一律存成 f64（读进来的整数也换成 f64，[`normalize`]），结构相等即 JS 的值相等。

use dolce_base::js::num_to_string;
use serde_json::{Map, Number, Value};

/// JS 的「普通对象」：非 null、非数组的对象。
pub fn is_plain_object(v: &Value) -> bool {
    v.is_object()
}

/// 一个 f64 的 JSON 值（非有限数照 `JSON.stringify` 写成 null）。
pub fn num(x: f64) -> Value {
    Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

/// 数值读出（JS 的 `typeof v === "number"`）。
pub fn as_num(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// 读进来的 JSON 里整数换成 f64：两边的数都按 f64 存，结构比较才等同 JS 的 `===`。
pub fn normalize(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if !n.is_f64() {
                if let Some(x) = n.as_f64() {
                    *v = num(x);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(normalize),
        Value::Object(o) => o.values_mut().for_each(normalize),
        _ => {}
    }
}

/// `mergeStyle(base, patch)`：深合并（数组整体替换），不改入参。`patch` 为 null 时回 `base`。
pub fn merge_style(base: &Value, patch: &Value) -> Value {
    if patch.is_null() {
        return base.clone();
    }
    let (Value::Object(b), Value::Object(p)) = (base, patch) else {
        return patch.clone();
    };
    let mut out = b.clone();
    for (k, v) in p {
        let merged = match (v, out.get(k)) {
            (Value::Object(_), Some(cur @ Value::Object(_))) => merge_style(cur, v),
            _ => v.clone(),
        };
        out.insert(k.clone(), merged);
    }
    Value::Object(out)
}

/// `a === b`（`b` 缺 = undefined）。对象与数组按身份比，两份不同的值一律不等。
pub fn strict_eq(a: &Value, b: Option<&Value>) -> bool {
    match (a, b) {
        (_, None) => false,
        (Value::Null, Some(Value::Null)) => true,
        (Value::Bool(x), Some(Value::Bool(y))) => x == y,
        (Value::Number(x), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Value::String(x), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `String(v)` / 模板串里的 `${v}`。
pub fn js_to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_to_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `JSON.stringify(s)`（字符串）。
pub fn json_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `JSON.stringify(v)`（紧凑写法，数按 JS 口径）。
pub fn js_json(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if x.is_finite() {
                num_to_string(x)
            } else {
                "null".into()
            }
        }
        Value::String(s) => json_quote(s),
        Value::Array(a) => format!("[{}]", a.iter().map(js_json).collect::<Vec<_>>().join(",")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}:{}", json_quote(k), js_json(v))).collect::<Vec<_>>().join(",")),
    }
}

/// `Object.keys(o).length`（非对象当空）。
pub fn key_count(v: &Value) -> usize {
    v.as_object().map_or(0, Map::len)
}

/// `o[a][b]…`：逐级取，中途不是对象就回 None。
pub fn get_path<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for k in path {
        cur = cur.as_object()?.get(*k)?;
    }
    Some(cur)
}

/// 字符串值（JS 的 `typeof v === "string"`）。
pub fn as_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// `x >>> 0`。
pub fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    t.rem_euclid(4294967296.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merge() {
        let a = json!({"a": {"x": 1.0, "y": [1.0]}, "b": 2.0});
        let b = json!({"a": {"y": [3.0], "z": true}, "c": null});
        assert_eq!(js_json(&merge_style(&a, &b)), r#"{"a":{"x":1,"y":[3],"z":true},"b":2,"c":null}"#);
    }

    #[test]
    fn quote() {
        assert_eq!(json_quote("a\"b\u{1}\n中"), "\"a\\\"b\\u0001\\n中\"");
    }
}
