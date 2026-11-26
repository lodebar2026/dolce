//! 交给界面的提示（同 `model/msg.ts::ModelMsg`）：只给键与参数，翻成哪种语言是 TS `t()` 的事。

use serde::{Deserialize, Serialize};

/// 参数值：文字、数、或另一条提示（声部名缺省是「另一声部」，也要按语言出）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "base.gen.ts"))]
#[serde(untagged)]
pub enum MsgArg {
    Str(String),
    Num(f64),
    Msg(Box<Msg>),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "base.gen.ts"))]
pub struct Msg {
    pub key: String,
    /// 按给出的次序（TS 对象字面的键序）；没有参数时不写
    #[serde(default, skip_serializing_if = "Vec::is_empty", with = "ordered_args")]
    #[cfg_attr(feature = "ts", ts(as = "Option<std::collections::HashMap<String, MsgArg>>", optional))]
    pub args: Vec<(String, MsgArg)>,
}

impl Msg {
    pub fn new(key: impl Into<String>) -> Msg {
        Msg { key: key.into(), args: Vec::new() }
    }
    pub fn arg(mut self, name: impl Into<String>, v: impl Into<MsgArg>) -> Msg {
        self.args.push((name.into(), v.into()));
        self
    }
}

impl From<&str> for MsgArg {
    fn from(s: &str) -> Self {
        MsgArg::Str(s.into())
    }
}
impl From<String> for MsgArg {
    fn from(s: String) -> Self {
        MsgArg::Str(s)
    }
}
impl From<f64> for MsgArg {
    fn from(n: f64) -> Self {
        MsgArg::Num(n)
    }
}
impl From<Msg> for MsgArg {
    fn from(m: Msg) -> Self {
        MsgArg::Msg(Box::new(m))
    }
}

/// `args` 在 JSON 里是对象（键序 = 给出的次序）。
mod ordered_args {
    use super::MsgArg;
    use serde::de::{MapAccess, Visitor};
    use serde::ser::SerializeMap;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[(String, MsgArg)], s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(v.len()))?;
        for (k, a) in v {
            m.serialize_entry(k, a)?;
        }
        m.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<(String, MsgArg)>, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Vec<(String, MsgArg)>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("提示参数对象")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                let mut out = Vec::new();
                while let Some(e) = a.next_entry()? {
                    out.push(e);
                }
                Ok(out)
            }
        }
        d.deserialize_map(V)
    }
}
