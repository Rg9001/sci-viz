// Math engine: validates expressions and computes plot data and features
// (roots, extrema, inflection points, asymptotes, tangents, areas) exactly/numerically
// so graphs never rely on hand-computed numbers.
import { create, all } from "mathjs";

export const math = create(all);
export class MathError extends Error {}

const CONSTANTS = new Set(["e", "E", "pi", "PI", "i", "Infinity", "NaN", "phi", "tau"]);

export function prep(expr) {
  return String(expr)
    .replace(/^\s*[a-zA-Z]\s*(\([a-z]\))?\s*=\s*/, "")
    .replace(/[−–]/g, "-").replace(/×|·/g, "*").replace(/÷/g, "/").replace(/π/g, "pi")
    .replace(/√\s*\(/g, "sqrt(").replace(/\bln\s*\(/g, "log(").replace(/²/g, "^2").replace(/³/g, "^3");
}

/** Parse + check that the expression only uses the allowed variables. */
export function parseExpr(expr, vars = ["x"]) {
  let node;
  try { node = math.parse(prep(expr)); } catch (e) { throw new MathError(`Couldn't parse "${expr}": ${e.message}`); }
  const unknown = new Set();
  node.traverse((n, path, parent) => {
    if (n.isSymbolNode && !(parent && parent.isFunctionNode && path === "fn") && !CONSTANTS.has(n.name) && !vars.includes(n.name)) unknown.add(n.name);
  });
  if (unknown.size) throw new MathError(`"${expr}" uses unknown symbol(s) ${[...unknown].join(", ")}; only ${vars.join(", ")} are allowed (use math.js syntax, e.g. 3*x, sin(x), e^x, log(x) for ln).`);
  return node;
}

export function toTex(node) {
  try { return node.toTex({ parenthesis: "auto", implicit: "hide" }).replace(/\\cdot(?!\s*[\d.])/g, "\\,"); } catch { return node.toString(); }
}

export function makeFn(node, v = "x") {
  const c = node.compile();
  return (x) => {
    try {
      const y = c.evaluate({ [v]: x });
      return typeof y === "number" && Number.isFinite(y) ? y : NaN;
    } catch { return NaN; }
  };
}

function derivNode(node, v = "x") {
  try { return math.derivative(node, v); } catch { return null; }
}
function numDeriv(f) { return (x) => { const h = 1e-5 * Math.max(1, Math.abs(x)); return (f(x + h) - f(x - h)) / (2 * h); }; }

// ---------- Nice number formatting (exact forms when the value is clearly one) ----------
export function nice(v) {
  if (!Number.isFinite(v)) return { text: "undefined", tex: "\\text{undefined}", exact: false };
  const tol = 1e-9 * Math.max(1, Math.abs(v));
  const r = Math.round(v);
  if (Math.abs(v - r) < tol) return { text: String(r === 0 ? 0 : r), tex: String(r === 0 ? 0 : r), exact: true };
  for (let q = 2; q <= 12; q++) {
    const p = Math.round(v * q);
    if (Math.abs(v - p / q) < tol && gcd(Math.abs(p), q) === 1) return { text: `${p}/${q}`, tex: `${p < 0 ? "-" : ""}\\tfrac{${Math.abs(p)}}{${q}}`, exact: true };
  }
  for (let q = 1; q <= 12; q++) {
    const p = Math.round((v / Math.PI) * q);
    if (p !== 0 && Math.abs(v - (p * Math.PI) / q) < tol && gcd(Math.abs(p), q) === 1) {
      const num = Math.abs(p) === 1 ? "π" : `${Math.abs(p)}π`, sign = p < 0 ? "-" : "";
      const tnum = Math.abs(p) === 1 ? "\\pi" : `${Math.abs(p)}\\pi`;
      return q === 1 ? { text: sign + num, tex: sign + tnum, exact: true } : { text: `${sign}${num}/${q}`, tex: `${sign}\\tfrac{${tnum}}{${q}}`, exact: true };
    }
  }
  for (let q = 1; q <= 6; q++) {
    const s2 = (v * q) ** 2, n = Math.round(s2);
    if (n > 1 && n < 400 && Math.abs(s2 - n) < 1e-8 * Math.max(1, n) && !Number.isInteger(Math.sqrt(n)) && squareFree(n)) {
      const sign = v < 0 ? "-" : "";
      return q === 1 ? { text: `${sign}√${n}`, tex: `${sign}\\sqrt{${n}}`, exact: true } : { text: `${sign}√${n}/${q}`, tex: `${sign}\\tfrac{\\sqrt{${n}}}{${q}}`, exact: true };
    }
  }
  const s = (+v.toPrecision(5)).toString();
  return { text: `≈${s}`, tex: `\\approx ${s}`, exact: false };
}
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function squareFree(n) { for (let k = 2; k * k <= n; k++) if (n % (k * k) === 0) return false; return true; }
const nt = (v) => nice(v).text.replace(/^≈/, "");

// ---------- Root finding ----------
function bisect(g, a, b, ga, gb) {
  for (let i = 0; i < 100; i++) {
    const m = (a + b) / 2, gm = g(m);
    if (!Number.isFinite(gm)) return null;
    if (gm === 0 || (b - a) / 2 < 1e-13 * Math.max(1, Math.abs(m))) return m;
    if (Math.sign(gm) === Math.sign(ga)) { a = m; ga = gm; } else { b = m; gb = gm; }
  }
  return (a + b) / 2;
}

/** Sign-change roots of g on [x0,x1]; skips sign changes across discontinuities of f. */
function signRoots(g, x0, x1, N, isBreak) {
  const out = [];
  let px = x0, pg = g(x0);
  for (let k = 1; k <= N; k++) {
    const x = x0 + ((x1 - x0) * k) / N, gx = g(x);
    if (Number.isFinite(pg) && Number.isFinite(gx)) {
      if (gx === 0) { if (pg !== 0) out.push(x); }
      else if (pg !== 0 && Math.sign(pg) !== Math.sign(gx) && !isBreak(px, x)) {
        const r = bisect(g, px, x, pg, gx);
        if (r != null) out.push(r);
      }
    }
    px = x; pg = gx;
  }
  return dedupe(out, (x1 - x0) * 1e-7);
}
function dedupe(xs, eps) { xs.sort((a, b) => a - b); return xs.filter((x, i) => i === 0 || Math.abs(x - xs[i - 1]) > eps); }

// ---------- Sampling with discontinuity detection ----------
function sample(f, x0, x1, N = 1400) {
  const xs = [], ys = [];
  for (let k = 0; k <= N; k++) { const x = x0 + ((x1 - x0) * k) / N; xs.push(x); ys.push(f(x)); }
  return { xs, ys };
}

function robustRange(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [-1, 1];
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  let lo = q(0.02), hi = q(0.98);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  return [lo - pad, hi + pad];
}

/** True if f has a jump/blow-up between a and b (refined by bisection). */
function makeBreakTest(f, threshold) {
  return (a, b) => {
    let fa = f(a), fb = f(b);
    if (!Number.isFinite(fa) || !Number.isFinite(fb)) return true;
    if (Math.abs(fb - fa) < threshold) return false;
    for (let i = 0; i < 60; i++) {
      const m = (a + b) / 2, fm = f(m);
      if (!Number.isFinite(fm)) return true;
      // keep the half with the bigger jump
      if (Math.abs(fm - fa) > Math.abs(fb - fm)) { b = m; fb = fm; } else { a = m; fa = fm; }
      if (Math.abs(fb - fa) < threshold) return false;
      if (b - a < 1e-12 * Math.max(1, Math.abs(a))) return true;
    }
    return true;
  };
}

/**
 * Analyse and sample one function.
 * features: subset of roots, extrema, inflection, asymptotes, y_intercept
 */
export function analyzeFunction({ expr, features = [], tangentAt, shadeFrom, shadeTo }, x0, x1) {
  const node = parseExpr(expr);
  const f = makeFn(node);
  const d1n = derivNode(node), d1 = d1n ? makeFn(d1n) : numDeriv(f);
  const d2n = d1n ? derivNode(d1n) : null, d2 = d2n ? makeFn(d2n) : numDeriv(d1);
  const { xs, ys } = sample(f, x0, x1);
  const [lo, hi] = robustRange(ys);
  const isBreak = makeBreakTest(f, (hi - lo) * 0.05);
  // Insert gaps at discontinuities.
  const X = [], Y = [];
  for (let k = 0; k < xs.length; k++) {
    if (k > 0 && Number.isFinite(ys[k - 1]) && Number.isFinite(ys[k]) && isBreak(xs[k - 1], xs[k])) { X.push(null); Y.push(null); }
    X.push(xs[k]); Y.push(Number.isFinite(ys[k]) ? ys[k] : null);
  }
  const out = { expr, tex: toTex(node), x: X, y: Y, range: [lo, hi], features: [], lines: [], warnings: [] };
  const N = 4000;
  const want = new Set(features);
  const label = (kind, x, y) => ({ kind, x, y, xText: nt(x), yText: nt(y), text: `(${nice(x).text}, ${nice(y).text})` });

  // Vertical asymptotes / jumps.
  const big = 5 * Math.max(1, Math.abs(hi), Math.abs(lo));
  const golden = (g, a, b) => { // minimise g on [a,b]
    const r = (Math.sqrt(5) - 1) / 2;
    let c = b - r * (b - a), d = a + r * (b - a);
    for (let i = 0; i < 200 && b - a > 1e-15 * Math.max(1, Math.abs(a)); i++) {
      if (g(c) < g(d)) { b = d; } else { a = c; }
      c = b - r * (b - a); d = a + r * (b - a);
    }
    return (a + b) / 2;
  };
  const inv = (x) => { const y = f(x); return Number.isFinite(y) ? 1 / Math.abs(y) : 0; };
  const snap = (x) => { const n = nice(x); if (!n.exact) return x; const v = math.evaluate(n.text.replace(/π/g, "pi").replace(/√(\d+)/g, "sqrt($1)")); return Math.abs(v - x) < 1e-7 * Math.max(1, Math.abs(x)) ? v : x; };
  const breaks = [];
  for (let k = 1; k < xs.length; k++) {
    const fa = ys[k - 1], fb = ys[k];
    if (Number.isFinite(fa) && Number.isFinite(fb)) {
      if (!isBreak(xs[k - 1], xs[k])) continue;
      let a = xs[k - 1], b = xs[k];
      for (let i = 0; i < 80; i++) { const m = (a + b) / 2; if (isBreak(a, m)) b = m; else a = m; }
      let xa = (a + b) / 2;
      const blow = Math.max(Math.abs(f(xa - 1e-9 * Math.max(1, Math.abs(xa)))), Math.abs(f(xa + 1e-9 * Math.max(1, Math.abs(xa))))) > big;
      if (blow) { const w = 1e-6 * Math.max(1, Math.abs(xa)); xa = golden(inv, xa - w, xa + w); }
      breaks.push({ x: snap(xa), blow });
    } else if (Number.isFinite(fa) !== Number.isFinite(fb)) {
      // Edge of an undefined region (or a single undefined sample at a pole): locate it.
      let a = xs[k - 1], b = xs[k];
      const finA = Number.isFinite(fa);
      for (let i = 0; i < 100; i++) { const m = (a + b) / 2; if (Number.isFinite(f(m)) === finA) a = m; else b = m; }
      const edge = finA ? a : b, dir = finA ? -1 : 1, h = 1e-10 * Math.max(1, Math.abs(edge));
      const blow = Math.abs(f(edge + dir * h)) > big;
      const xa = snap((a + b) / 2);
      if (!breaks.some((br) => Math.abs(br.x - xa) < 1e-9 * Math.max(1, Math.abs(xa)))) breaks.push({ x: xa, blow, edge: true });
    }
  }
  const nearBreak = (x) => breaks.some((b) => Math.abs(b.x - x) < (x1 - x0) * 1e-6);
  const cont = (a, b) => isBreak(a, b);

  if (want.has("roots")) {
    const roots = signRoots(f, x0, x1, N, cont);
    // touching roots: extrema where f ≈ 0
    for (const c of signRoots(d1, x0, x1, N, cont)) if (Math.abs(f(c)) < 1e-9 && !roots.some((r) => Math.abs(r - c) < 1e-6)) roots.push(c);
    roots.filter((r) => !nearBreak(r)).sort((a, b) => a - b).forEach((r) => out.features.push(label("root", r, 0)));
  }
  if (want.has("extrema")) {
    for (const c of signRoots(d1, x0, x1, N, cont)) {
      if (nearBreak(c) || !Number.isFinite(f(c))) continue;
      const h = 1e-4 * Math.max(1, x1 - x0);
      const l = d1(c - h), r = d1(c + h);
      const kind = l > 0 && r < 0 ? "local max" : l < 0 && r > 0 ? "local min" : null;
      if (kind) out.features.push(label(kind, c, f(c)));
    }
  }
  if (want.has("inflection")) {
    for (const c of signRoots(d2, x0, x1, N, cont)) {
      if (nearBreak(c) || !Number.isFinite(f(c))) continue;
      const h = 1e-4 * Math.max(1, x1 - x0);
      if (Math.sign(d2(c - h)) !== Math.sign(d2(c + h))) out.features.push(label("inflection", c, f(c)));
    }
  }
  if (want.has("y_intercept") && x0 <= 0 && x1 >= 0 && Number.isFinite(f(0))) out.features.push(label("y-intercept", 0, f(0)));
  if (want.has("asymptotes")) {
    for (const b of breaks) if (b.blow) out.lines.push({ kind: "vertical asymptote", x: b.x, text: `x = ${nice(b.x).text}`, tex: `x = ${nice(b.x).tex}` });
    for (const sgn of [1, -1]) {
      const a = f(sgn * 1e6), b2 = f(sgn * 1e8);
      if (Number.isFinite(a) && Number.isFinite(b2) && Math.abs(a - b2) < 1e-4 * Math.max(1, Math.abs(b2))) {
        const L = Math.abs(b2) < 1e-6 ? 0 : b2;
        if (!out.lines.some((l) => l.y != null && Math.abs(l.y - L) < 1e-6)) out.lines.push({ kind: "horizontal asymptote", y: L, text: `y = ${nice(L).text}`, tex: `y = ${nice(L).tex}` });
      }
    }
  }
  if (tangentAt != null) {
    const a = tangentAt, fa = f(a), m = d1(a);
    if (!Number.isFinite(fa) || !Number.isFinite(m)) out.warnings.push(`No tangent at x = ${a}: f or f′ is undefined there.`);
    else {
      const b = fa - m * a;
      const coef = (m) => { const n = nice(m).tex.replace("\\approx ", ""); return n === "1" ? "" : n === "-1" ? "-" : n; };
      const mZero = Math.abs(m) < 1e-12, bZero = Math.abs(b) < 1e-12;
      const bAbs = nice(Math.abs(b)).tex.replace("\\approx ", "");
      const tex = mZero ? `y = ${nice(b).tex.replace("\\approx ", "")}` : `y = ${coef(m)}x${bZero ? "" : (b < 0 ? " - " : " + ") + bAbs}`;
      out.tangent = { x0: a, slope: m, intercept: b, x: [x0, x1], y: [fa + m * (x0 - a), fa + m * (x1 - a)], tex,
        point: label("tangent point", a, fa) };
    }
  }
  if (shadeFrom != null && shadeTo != null) {
    const a = Math.min(shadeFrom, shadeTo), b = Math.max(shadeFrom, shadeTo);
    const crosses = breaks.some((br) => br.x > a && br.x < b);
    const val = crosses ? NaN : integrate(f, shadeFrom, shadeTo);
    const sx = [], sy = [];
    for (let k = 0; k <= 400; k++) { const x = a + ((b - a) * k) / 400; sx.push(x); sy.push(Number.isFinite(f(x)) ? f(x) : null); }
    out.shade = { x: sx, y: sy, from: shadeFrom, to: shadeTo, value: val,
      tex: `\\int_{${nice(shadeFrom).tex}}^{${nice(shadeTo).tex}} f(x)\\,dx ${Number.isFinite(val) ? (nice(val).exact ? "= " + nice(val).tex : nice(val).tex) : "\\text{ diverges / undefined}"}` };
    if (crosses) out.warnings.push(`The shaded interval [${shadeFrom}, ${shadeTo}] crosses a discontinuity, so the integral is improper/undefined.`);
  }
  return out;
}

/** Adaptive Simpson integration. */
export function integrate(f, a, b) {
  const simpson = (a, b, fa, fm, fb) => ((b - a) / 6) * (fa + 4 * fm + fb);
  const rec = (a, b, fa, fm, fb, whole, eps, depth) => {
    const m = (a + b) / 2, lm = (a + m) / 2, rm = (m + b) / 2;
    const flm = f(lm), frm = f(rm);
    const left = simpson(a, m, fa, flm, fm), right = simpson(m, b, fm, frm, fb);
    if (depth <= 0 || Math.abs(left + right - whole) <= 15 * eps) return left + right + (left + right - whole) / 15;
    return rec(a, m, fa, flm, fm, left, eps / 2, depth - 1) + rec(m, b, fm, frm, fb, right, eps / 2, depth - 1);
  };
  const fa = f(a), fb = f(b), fm = f((a + b) / 2);
  if (![fa, fb, fm].every(Number.isFinite)) return NaN;
  return rec(a, b, fa, fm, fb, simpson(a, b, fa, fm, fb), 1e-12, 50);
}

/** Check user-supplied points lie on one of the curves. */
export function checkPoints(points, fns) {
  return points.map((p) => {
    if (p.onCurve === false) return { ...p, ok: true };
    const ok = fns.some((f) => { const y = f(p.x); return Number.isFinite(y) && Math.abs(y - p.y) <= 1e-6 * Math.max(1, Math.abs(p.y)); });
    const closest = fns.map((f) => f(p.x)).filter(Number.isFinite);
    return { ...p, ok, actual: closest.length ? closest[0] : null };
  });
}

/** Sample a surface on a grid. */
export function sampleSurface(expr, x0, x1, y0, y1, n = 70) {
  const node = parseExpr(expr, ["x", "y"]);
  const c = node.compile();
  const xs = [], ys = [], zs = [];
  for (let i = 0; i <= n; i++) xs.push(x0 + ((x1 - x0) * i) / n);
  for (let j = 0; j <= n; j++) ys.push(y0 + ((y1 - y0) * j) / n);
  for (const y of ys) zs.push(xs.map((x) => { try { const z = c.evaluate({ x, y }); return typeof z === "number" && Number.isFinite(z) ? z : null; } catch { return null; } }));
  return { x: xs, y: ys, z: zs, tex: toTex(node) };
}
