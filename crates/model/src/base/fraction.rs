//! `src/common/fraction.ts` 照搬：分子分母是 JS 的 number（f64），约分、比较、四则都照 TS 的浮点算法，
//! 不改成整数（TS 里分母乘爆 2^53 的地方 Rust 也得到同样的近似值）。

use crate::base::js;

/// 最大公约数（恒非负；gcd(0,0)=0）。`%` 是 JS 的取余（同 Rust f64 的 `%`）。
///
/// 与 TS 唯一的出入：参数里有 NaN 时 TS 的循环永不停（`NaN !== 0`），这里回 NaN。
pub fn gcd(numerator: f64, denominator: f64) -> f64 {
    let mut a = numerator;
    let mut b = denominator;
    while b != 0.0 {
        if b.is_nan() {
            return f64::NAN;
        }
        let old_b = b;
        b = a % b;
        a = old_b;
    }
    a.abs()
}

/// 最小公倍数。任一为 0 时返回另一个的绝对值（避免除零）。
pub fn lcm(a: f64, b: f64) -> f64 {
    let g = gcd(a, b);
    if g == 0.0 {
        // `Math.abs(a || b)`：a 为 0 或 NaN 时取 b
        if a == 0.0 || a.is_nan() {
            b.abs()
        } else {
            a.abs()
        }
    } else {
        ((a / g) * b).abs()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Fraction {
    pub numerator: f64,
    pub denominator: f64,
}

impl Default for Fraction {
    fn default() -> Self {
        Fraction { numerator: 0.0, denominator: 1.0 }
    }
}

impl Fraction {
    /// 构造并约分（分母为负时分子分母同变号）。
    pub fn new(num: f64, den: f64) -> Fraction {
        let (mut n, mut d) = if den < 0.0 { (-num, -den) } else { (num, den) };
        let g = gcd(n, d);
        // `gcd(...) || 1`
        let g = if g == 0.0 || g.is_nan() { 1.0 } else { g };
        n /= g;
        d /= g;
        Fraction { numerator: n, denominator: d }
    }

    pub fn int(n: f64) -> Fraction {
        Fraction::new(n, 1.0)
    }

    /// `"3"` / `"3/4"`，两边各按 `parseInt(…, 10)` 读。
    pub fn from_string(s: &str) -> Fraction {
        match s.find('/') {
            None => Fraction::int(js::parse_int(s, 10)),
            Some(i) => Fraction::new(js::parse_int(&s[..i], 10), js::parse_int(&s[i + 1..], 10)),
        }
    }

    /// -1 / 0 / 1（有 NaN 时为 0）。
    pub fn compare_to(&self, other: &Fraction) -> i32 {
        let m = self.numerator * other.denominator;
        let o = other.numerator * self.denominator;
        if m < o {
            -1
        } else if m > o {
            1
        } else {
            0
        }
    }

    pub fn to_float(&self) -> f64 {
        self.numerator / self.denominator
    }
    pub fn to_int(&self) -> f64 {
        (self.numerator / self.denominator).trunc()
    }

    pub fn plus(&self, o: &Fraction) -> Fraction {
        Fraction::new(self.numerator * o.denominator + o.numerator * self.denominator, self.denominator * o.denominator)
    }
    pub fn minus(&self, o: &Fraction) -> Fraction {
        Fraction::new(self.numerator * o.denominator - o.numerator * self.denominator, self.denominator * o.denominator)
    }
    pub fn times(&self, o: &Fraction) -> Fraction {
        Fraction::new(self.numerator * o.numerator, self.denominator * o.denominator)
    }
    pub fn times_int(&self, o: f64) -> Fraction {
        Fraction::new(self.numerator * o, self.denominator)
    }
    pub fn div(&self, o: &Fraction) -> Fraction {
        Fraction::new(self.numerator * o.denominator, self.denominator * o.numerator)
    }
    pub fn div_int(&self, o: f64) -> Fraction {
        Fraction::new(self.numerator, self.denominator * o)
    }

    pub fn equals(&self, o: &Fraction) -> bool {
        self.compare_to(o) == 0
    }
    pub fn equals_int(&self, o: f64) -> bool {
        self.compare_to(&Fraction::int(o)) == 0
    }
}

/// 过边界写成 `[分子, 分母]`（TS 侧 `[f.numerator, f.denominator]`），读回不再约分——原样保留两边的 f64。
impl serde::Serialize for Fraction {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        (self.numerator, self.denominator).serialize(s)
    }
}

impl<'de> serde::Deserialize<'de> for Fraction {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let (numerator, denominator) = <(f64, f64)>::deserialize(d)?;
        Ok(Fraction { numerator, denominator })
    }
}

impl std::fmt::Display for Fraction {
    /// `"3"` 或 `"3/4"`，数字按 `String(n)` 写。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.denominator == 1.0 {
            f.write_str(&js::num_to_string(self.numerator))
        } else {
            write!(f, "{}/{}", js::num_to_string(self.numerator), js::num_to_string(self.denominator))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduce_and_ops() {
        let a = Fraction::new(2.0, -4.0);
        assert_eq!((a.numerator, a.denominator), (-1.0, 2.0));
        assert_eq!(Fraction::from_string("6/8").to_string(), "3/4");
        assert_eq!(Fraction::from_string("3").to_string(), "3");
        assert_eq!(Fraction::new(1.0, 4.0).plus(&Fraction::new(1.0, 4.0)).to_string(), "1/2");
        assert_eq!(Fraction::new(1.0, 3.0).minus(&Fraction::new(1.0, 2.0)).to_string(), "-1/6");
        assert_eq!(Fraction::new(3.0, 4.0).div(&Fraction::new(3.0, 8.0)).to_string(), "2");
        assert_eq!(Fraction::new(7.0, 2.0).to_int(), 3.0);
        assert_eq!(Fraction::new(-7.0, 2.0).to_int(), -3.0);
        assert!(Fraction::new(2.0, 4.0).equals(&Fraction::new(1.0, 2.0)));
        assert_eq!(Fraction::new(0.0, 0.0).denominator, 0.0); // 0/0：gcd 为 0，按 1 约（同 TS）
        assert_eq!(lcm(0.0, 6.0), 0.0); // gcd(0,6)=6，同 TS
        assert_eq!(lcm(0.0, 0.0), 0.0);
        assert_eq!(lcm(4.0, 6.0), 12.0);
        assert!(Fraction::from_string("x/2").numerator.is_nan());
    }
}
