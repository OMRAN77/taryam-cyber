// Exact rational numbers on BigInt, so RTP and variance are computed without
// rounding and only rounded for display.
function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Fraction {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new RangeError('division by zero');
    if (den < 0n) { num = -num; den = -den; }
    const g = gcd(num, den) || 1n;
    this.num = num / g;
    this.den = den / g;
  }

  static of(x) {
    if (x instanceof Fraction) return x;
    if (typeof x === 'bigint') return new Fraction(x);
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) throw new RangeError('not finite');
      return Fraction.fromDecimal(String(x));
    }
    return Fraction.fromDecimal(String(x));
  }

  // "12.5", "-0.25", "1e-3" -> exact fraction of the decimal written.
  static fromDecimal(s) {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(s).trim());
    if (!m || (m[2] === '' && (m[3] || '') === '')) throw new RangeError('not a number: ' + s);
    const digits = (m[2] || '0') + (m[3] || '');
    let exp = -(m[3] || '').length + (m[4] ? parseInt(m[4], 10) : 0);
    let num = BigInt(digits) * (m[1] === '-' ? -1n : 1n);
    let den = 1n;
    if (exp >= 0) num *= 10n ** BigInt(exp); else den = 10n ** BigInt(-exp);
    return new Fraction(num, den);
  }

  add(o) { o = Fraction.of(o); return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o) { o = Fraction.of(o); return new Fraction(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o) { o = Fraction.of(o); return new Fraction(this.num * o.num, this.den * o.den); }
  div(o) { o = Fraction.of(o); return new Fraction(this.num * o.den, this.den * o.num); }
  neg() { return new Fraction(-this.num, this.den); }
  isZero() { return this.num === 0n; }
  cmp(o) { o = Fraction.of(o); const d = this.num * o.den - o.num * this.den; return d < 0n ? -1 : d > 0n ? 1 : 0; }
  equals(o) { return this.cmp(o) === 0; }

  toNumber() {
    // Scale so that very large numerators/denominators still convert accurately.
    const shift = BigInt(Math.max(0, this.den.toString(2).length - 1000));
    return Number(this.num >> shift) / Number(this.den >> shift);
  }

  // Decimal string rounded half away from zero to `digits` places.
  toDecimal(digits = 6) {
    const scale = 10n ** BigInt(digits);
    const neg = this.num < 0n;
    const n = neg ? -this.num : this.num;
    let q = (n * scale * 2n + this.den) / (this.den * 2n);
    const s = q.toString().padStart(digits + 1, '0');
    const out = digits ? s.slice(0, -digits) + '.' + s.slice(-digits) : s;
    return (neg && q !== 0n ? '-' : '') + out;
  }

  toPercent(digits = 4) { return this.mul(100).toDecimal(digits); }

  // Scientific notation in Number#toExponential's form ("7.277e-224"), rounded half
  // away from zero to `digits` places from the fraction itself, so it also holds far
  // outside a double's range (where toNumber() gives 0 or Infinity).
  toExponential(digits = 3) {
    if (this.num === 0n) return (0).toExponential(digits);
    const neg = this.num < 0n;
    const n = neg ? -this.num : this.num, d = this.den;
    // n / d lies in (10^(e-1), 10^(e+1)) for e = digits(n) - digits(d): e or e - 1.
    let e = n.toString().length - d.toString().length;
    const atLeast = (k) => (k >= 0 ? n >= d * 10n ** BigInt(k) : n * 10n ** BigInt(-k) >= d);
    if (!atLeast(e)) e -= 1;
    const k = digits - e;
    const [a, b] = k >= 0 ? [n * 10n ** BigInt(k), d] : [n, d * 10n ** BigInt(-k)];
    let m = (2n * a + b) / (2n * b);
    if (m >= 10n ** BigInt(digits + 1)) { m /= 10n; e += 1; } // 9.9996 -> 1.000e+1
    const s = m.toString();
    return (neg ? '-' : '') + s[0] + (digits ? '.' + s.slice(1) : '') + 'e' + (e < 0 ? '-' : '+') + Math.abs(e);
  }

  toString() { return this.den === 1n ? this.num.toString() : this.num + '/' + this.den; }

  toJSON() { return { num: this.num.toString(), den: this.den.toString() }; }
}

export const ZERO = new Fraction(0n);
export const ONE = new Fraction(1n);
