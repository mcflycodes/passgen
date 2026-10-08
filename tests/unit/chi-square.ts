// Pearson's chi-square test for the randomness tests, with an exact p-value
// from the regularized upper incomplete gamma function Q(k/2, x/2). Test-only.

/** Pearson's statistic for observed counts against an expected count per cell (one number, or one per cell). */
export function chiSquareStatistic(observed: readonly number[], expected: number | readonly number[]): number {
  let stat = 0;
  for (let i = 0; i < observed.length; i += 1) {
    const e = typeof expected === "number" ? expected : (expected[i] ?? Number.NaN);
    const o = observed[i] ?? Number.NaN;
    stat += ((o - e) * (o - e)) / e;
  }
  return stat;
}

/** P(X >= stat) for X ~ chi-square with `df` degrees of freedom: the upper-tail p-value. */
export function chiSquarePValue(stat: number, df: number): number {
  if (!(stat >= 0) || !(df > 0)) throw new RangeError(`chiSquarePValue(${stat}, ${df})`);
  return gammaQ(df / 2, stat / 2);
}

// Lanczos approximation (g = 7, n = 9), accurate to about 1e-15 for positive arguments.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let sum = LANCZOS[0] as number;
  for (let i = 1; i < LANCZOS.length; i += 1) sum += (LANCZOS[i] as number) / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}

const EPS = 1e-16;
const MAX_ITERATIONS = 10000;

/** Regularized upper incomplete gamma Q(a, x) = Γ(a, x) / Γ(a). */
function gammaQ(a: number, x: number): number {
  if (x === 0) return 1;
  if (x < a + 1) return 1 - gammaPSeries(a, x);
  return gammaQContinuedFraction(a, x);
}

/** Series for P(a, x), converges fast for x < a + 1. */
function gammaPSeries(a: number, x: number): number {
  let term = 1 / a;
  let sum = term;
  for (let n = 1; n <= MAX_ITERATIONS; n += 1) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Lentz's continued fraction for Q(a, x), converges fast for x >= a + 1. */
function gammaQContinuedFraction(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAX_ITERATIONS; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}
