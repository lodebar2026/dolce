//! 样式值的长度单位（照 `style/units.ts`）。**只在适配器里换算**，排版引擎一律只见数字。
//!
//! pt 绝对长度（裸数字也按 pt）；em 所在角色的字号；sp 线距 = 名义谱高 / 4。

use dolce_model::base::js::{is_space, number};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LengthUnit {
    Pt,
    Em,
    Sp,
}

/// 换算上下文：1em 与 1sp 各是多少（引擎自己的口径）。`pt` 缺 = 1（排版单位就是 pt）；
/// 五线谱的 tenths 要等 `<scaling>` 读进来才知道，那一路给 NaN → pt 不可用。
#[derive(Clone, Copy, Debug)]
pub struct LengthContext {
    pub em: f64,
    pub sp: f64,
    pub pt: Option<f64>,
}

/// `/^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*(pt|em|sp)\s*$/` 的读法：回数字串与单位。
fn match_length(s: &str) -> Option<(&str, LengthUnit)> {
    let t = s.trim_start_matches(is_space).trim_end_matches(is_space);
    let (body, unit) = [("pt", LengthUnit::Pt), ("em", LengthUnit::Em), ("sp", LengthUnit::Sp)]
        .into_iter()
        .find_map(|(u, k)| t.strip_suffix(u).map(|b| (b, k)))?;
    let body = body.trim_end_matches(is_space);
    if !is_js_decimal(body) {
        return None;
    }
    Some((body, unit))
}

/// `-?\d+(?:\.\d+)?|-?\.\d+`（整串）。
pub(crate) fn is_js_decimal(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    match s.split_once('.') {
        None => digits(s),
        Some((a, b)) => (a.is_empty() || digits(a)) && digits(b),
    }
}

/// `parseLength`：认不出（含不支持的单位）回 None。
pub fn parse_length(v: &Value) -> Option<(f64, LengthUnit)> {
    match v {
        Value::Number(n) => {
            let x = n.as_f64()?;
            x.is_finite().then_some((x, LengthUnit::Pt))
        }
        Value::String(s) => match_length(s).map(|(d, u)| (number(d), u)),
        _ => None,
    }
}

/// `resolveLength`：长度 → 引擎口径的数字。**裸数字原样返回**（不乘 1）。认不出或该口径下不可用回 None。
pub fn resolve_length(v: &Value, ctx: LengthContext) -> Option<f64> {
    if let Value::Number(n) = v {
        let x = n.as_f64()?;
        if !x.is_finite() {
            return None;
        }
        return match ctx.pt {
            None | Some(1.0) => Some(x),
            Some(k) => k.is_finite().then_some(x * k),
        };
    }
    let (value, unit) = parse_length(v)?;
    match unit {
        LengthUnit::Em => Some(value * ctx.em),
        LengthUnit::Sp => Some(value * ctx.sp),
        LengthUnit::Pt => {
            let k = ctx.pt.unwrap_or(1.0);
            k.is_finite().then_some(value * k)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lengths() {
        let c = LengthContext { em: 12.0, sp: 4.0, pt: None };
        assert_eq!(resolve_length(&json!("0.5em"), c), Some(6.0));
        assert_eq!(resolve_length(&json!(" -.5 sp "), c), Some(-2.0));
        assert_eq!(resolve_length(&json!("1.em"), c), None);
        assert_eq!(resolve_length(&json!("3pt"), LengthContext { pt: Some(f64::NAN), ..c }), None);
        assert_eq!(resolve_length(&json!(3.0), LengthContext { pt: Some(f64::NAN), ..c }), None);
    }
}
