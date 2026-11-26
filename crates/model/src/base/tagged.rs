//! 内部标记枚举（`{"kind": "chord", …}` 这种，标记与内容同在一个对象里）的手写反序列化。
//!
//! serde 派生的 `#[serde(tag = "kind")]` 不知道标记在第几个键，只能先把整个对象读进中间缓冲（`Content`）再分派，
//! 于是挂在枚举底下的每个类型都另编一份「从缓冲读」的反序列化代码——`Element` 一棵子树就让网页开机那份 wasm 多出约 700 KB。
//! 这里改成：
//! - **快路**：第一个键就是标记（Rust 写出的、TS 照字面量建的都是）——读出标记，把剩下的键原样交给变体自己的 `Deserialize`
//!   （经 [`MapAccessDeserializer`]），嵌套字段仍由原来的反序列化器读，不多编一份。
//! - **慢路**：标记不在第一个——收进 `serde_json::Value`、去掉标记、写回文本再按快路同一份代码读（`from_str`），不添新的泛型实例。
//!
//! JSON 形状不变；`Serialize` 照旧派生（标记写在第一个）。用法见 [`TaggedDe`]。
//! 变体多、又只派生 `Deserialize` 的（`EditCmd`）不必逐个写：派生改成外部标记的 `#[serde(remote = "Self")]`
//!（生成同名的固有函数 `Self::deserialize`），`fast` 里交 [`TagEnum`]（把「标记 + 剩下的对象」当外部标记枚举交出去）。
use serde::de::value::MapAccessDeserializer;
use serde::de::{DeserializeSeed, Deserializer, EnumAccess, Error, IgnoredAny, IntoDeserializer, MapAccess, VariantAccess, Visitor};
use std::fmt;
use std::marker::PhantomData;

/// 由标记分派到变体。实现 `fast`，再在 `Deserialize::deserialize` 里调 [`deserialize_tagged`]。
pub trait TaggedDe: Sized {
    /// 标记键名（如 `"kind"`）
    const TAG: &'static str;
    /// 报错里的类型名
    const NAME: &'static str;
    /// 按标记读出变体；`d` 交出的对象里已不含标记键。认不出的标记回 `D::Error::unknown_variant`。
    fn fast<'de, D: Deserializer<'de>>(tag: &str, d: D) -> Result<Self, D::Error>;
}

/// `Deserialize::deserialize` 的实现体。
pub fn deserialize_tagged<'de, T: TaggedDe, D: Deserializer<'de>>(d: D) -> Result<T, D::Error> {
    d.deserialize_map(TaggedVisitor::<T>(PhantomData))
}

struct TaggedVisitor<T>(PhantomData<T>);

impl<'de, T: TaggedDe> Visitor<'de> for TaggedVisitor<T> {
    type Value = T;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "带 `{}` 的 {}", T::TAG, T::NAME)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<T, A::Error> {
        let Some(first) = map.next_key::<String>()? else { return Err(A::Error::missing_field(T::TAG)) };
        if first == T::TAG {
            let tag: String = map.next_value()?;
            return T::fast(&tag, MapAccessDeserializer::new(map));
        }
        let mut obj = serde_json::Map::new();
        obj.insert(first, map.next_value()?);
        while let Some((k, v)) = map.next_entry::<String, serde_json::Value>()? {
            obj.insert(k, v);
        }
        let tag = match obj.remove(T::TAG) {
            Some(serde_json::Value::String(s)) => s,
            Some(_) => return Err(A::Error::custom(format!("{} 的 `{}` 不是字符串", T::NAME, T::TAG))),
            None => return Err(A::Error::missing_field(T::TAG)),
        };
        let text = serde_json::to_string(&obj).map_err(A::Error::custom)?;
        let mut de = serde_json::Deserializer::from_str(&text);
        T::fast(&tag, &mut de).map_err(A::Error::custom)
    }
}

/// 把「标记 + 剩下的对象」交给外部标记枚举的派生代码：变体名就是标记，结构体变体读剩下的键，新类型变体把剩下的对象交给内层类型，
/// 单元变体忽略剩下的键。
pub struct TagEnum<'t, D> {
    tag: &'t str,
    de: D,
}

impl<'t, D> TagEnum<'t, D> {
    pub fn new(tag: &'t str, de: D) -> Self {
        TagEnum { tag, de }
    }
}

impl<'de, D: Deserializer<'de>> Deserializer<'de> for TagEnum<'_, D> {
    type Error = D::Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, D::Error> {
        visitor.visit_enum(self)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf option unit unit_struct
        newtype_struct seq tuple tuple_struct map struct enum identifier ignored_any
    }
}

impl<'de, D: Deserializer<'de>> EnumAccess<'de> for TagEnum<'_, D> {
    type Error = D::Error;
    type Variant = Rest<D>;

    fn variant_seed<V: DeserializeSeed<'de>>(self, seed: V) -> Result<(V::Value, Rest<D>), D::Error> {
        let v = seed.deserialize(self.tag.into_deserializer())?;
        Ok((v, Rest(self.de)))
    }
}

/// 变体内容就是剩下的对象（`D` 读它）。
pub struct Rest<D>(D);

impl<'de, D: Deserializer<'de>> VariantAccess<'de> for Rest<D> {
    type Error = D::Error;

    fn unit_variant(self) -> Result<(), D::Error> {
        <IgnoredAny as serde::Deserialize>::deserialize(self.0).map(|_| ())
    }

    fn newtype_variant_seed<T: DeserializeSeed<'de>>(self, seed: T) -> Result<T::Value, D::Error> {
        seed.deserialize(self.0)
    }

    fn tuple_variant<V: Visitor<'de>>(self, _len: usize, visitor: V) -> Result<V::Value, D::Error> {
        self.0.deserialize_seq(visitor)
    }

    fn struct_variant<V: Visitor<'de>>(self, _fields: &'static [&'static str], visitor: V) -> Result<V::Value, D::Error> {
        self.0.deserialize_map(visitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct A {
        x: f64,
        #[serde(default)]
        kids: Vec<E>,
    }
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct B {
        y: String,
    }

    #[derive(Debug, PartialEq, Serialize)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    enum E {
        A(A),
        B(B),
    }

    impl TaggedDe for E {
        const TAG: &'static str = "kind";
        const NAME: &'static str = "E";
        fn fast<'de, D: Deserializer<'de>>(tag: &str, d: D) -> Result<Self, D::Error> {
            match tag {
                "a" => A::deserialize(d).map(E::A),
                "b" => B::deserialize(d).map(E::B),
                _ => Err(D::Error::unknown_variant(tag, &["a", "b"])),
            }
        }
    }
    impl<'de> Deserialize<'de> for E {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            deserialize_tagged(d)
        }
    }

    #[test]
    fn round_trip_and_key_order() {
        let v = E::A(A { x: 1.5, kids: vec![E::B(B { y: "q".into() })] });
        let s = serde_json::to_string(&v).unwrap();
        assert!(s.starts_with(r#"{"kind":"a""#));
        assert_eq!(serde_json::from_str::<E>(&s).unwrap(), v);
        // 标记不在第一个（慢路），嵌套的也不在
        let late = r#"{"x":1.5,"kids":[{"y":"q","kind":"b"}],"kind":"a"}"#;
        assert_eq!(serde_json::from_str::<E>(late).unwrap(), v);
        // 经 Value 读
        let val: serde_json::Value = serde_json::from_str(late).unwrap();
        assert_eq!(serde_json::from_value::<E>(val).unwrap(), v);
    }

    /// 外部标记派生 + `remote = "Self"` + `TagEnum`（`EditCmd` 的写法）
    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(remote = "Self", rename_all = "camelCase", rename_all_fields = "camelCase")]
    enum Cmd {
        SetX { the_x: f64, kids: Vec<E> },
        Wrap(B),
        Clear,
    }
    impl TaggedDe for Cmd {
        const TAG: &'static str = "op";
        const NAME: &'static str = "Cmd";
        fn fast<'de, D: Deserializer<'de>>(tag: &str, d: D) -> Result<Self, D::Error> {
            Cmd::deserialize(TagEnum::new(tag, d))
        }
    }
    impl<'de> Deserialize<'de> for Cmd {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            deserialize_tagged(d)
        }
    }

    #[test]
    fn external_via_tag_enum() {
        let want = Cmd::SetX { the_x: 2.0, kids: vec![E::B(B { y: "q".into() })] };
        assert_eq!(serde_json::from_str::<Cmd>(r#"{"op":"setX","theX":2,"kids":[{"kind":"b","y":"q"}]}"#).unwrap(), want);
        assert_eq!(serde_json::from_str::<Cmd>(r#"{"theX":2,"kids":[{"kind":"b","y":"q"}],"op":"setX"}"#).unwrap(), want);
        assert_eq!(serde_json::from_str::<Cmd>(r#"{"op":"wrap","y":"z"}"#).unwrap(), Cmd::Wrap(B { y: "z".into() }));
        assert_eq!(serde_json::from_str::<Cmd>(r#"{"op":"clear"}"#).unwrap(), Cmd::Clear);
        assert!(serde_json::from_str::<Cmd>(r#"{"op":"nope"}"#).unwrap_err().to_string().contains("unknown variant"));
        assert!(serde_json::from_str::<Cmd>(r#"{"op":"setX","kids":[]}"#).unwrap_err().to_string().contains("missing field `theX`"));
    }

    #[test]
    fn errors() {
        assert!(serde_json::from_str::<E>(r#"{"kind":"c"}"#).unwrap_err().to_string().contains("unknown variant"));
        assert!(serde_json::from_str::<E>(r#"{"y":"q"}"#).unwrap_err().to_string().contains("missing field `kind`"));
        // 变体的 deny_unknown_fields 两条路都生效
        assert!(serde_json::from_str::<E>(r#"{"kind":"b","y":"q","z":1}"#).unwrap_err().to_string().contains("unknown field"));
        assert!(serde_json::from_str::<E>(r#"{"y":"q","z":1,"kind":"b"}"#).unwrap_err().to_string().contains("unknown field"));
    }
}
