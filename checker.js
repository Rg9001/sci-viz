// Deterministic math verification so grading doesn't rely on the model alone.
import { create, all } from "mathjs";

const math = create(all);


const CONSTANTS = new Set(["e", "E", "pi", "PI", "i", "Infinity", "NaN"]);

function prep(expr) {
  // Accept common student notation: "y = ...", unicode symbols.
  return String(expr)
    .replace(/^\s*[a-zA-Z]\s*(\([a-z]\))?\s*=\s*/, "")
    .replace(/[−–]/g, "-").replace(/×|·/g, "*").replace(/÷/g, "/").replace(/π/g, "pi")
    .replace(/√\s*\(/g, "sqrt(").replace(/\bln\s*\(/g, "log(");
}

function variablesOf(...nodes) {
  const vars = new Set();
  for (const node of nodes) {
    node.traverse((n, path, parent) => {
      if (n.isSymbolNode && !(parent && parent.isFunctionNode && path === "fn") && !CONSTANTS.has(n.name)) {
        vars.add(n.name);
      }
    });
  }
  return [...vars];
}

// Compare two expressions numerically at many random points.
function numericallyEqual(nodeA, nodeB, vars) {
  const fa = nodeA.compile(), fb = nodeB.compile();
  let agreed = 0;
  for (let i = 0; i < 80 && agreed < 15; i++) {
    const scope = {};
    for (const v of vars) scope[v] = (Math.random() < 0.5 ? -1 : 1) * (0.2 + Math.random() * 2.8);
    let a, b;
    try { a = fa.evaluate(scope); b = fb.evaluate(scope); } catch { continue; }
    if (typeof a !== "number" || typeof b !== "number" || !isFinite(a) || !isFinite(b)) continue;
    if (Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))) return { equal: false, at: scope, a, b };
    agreed++;
  }
  return agreed >= 5 ? { equal: true } : { equal: null };
}

const fmt = (scope) => Object.entries(scope).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(", ");

/**
 * mode:
 *  - "equivalent":     studentExpr should equal referenceExpr (simplified answers, limits as values, etc.)
 *  - "derivative":     studentExpr should equal d/d(variable) of referenceExpr (referenceExpr = original function)
 *  - "antiderivative": d/d(variable) of studentExpr should equal referenceExpr (referenceExpr = integrand); +C allowed
 */
export function checkMath({ mode, studentExpr, referenceExpr, variable = "x" }) {
  let s, r;
  try { s = math.parse(prep(studentExpr)); } catch (e) { return { status: "error", detail: `Couldn't read your answer "${studentExpr}": ${e.message}` }; }
  try { r = math.parse(prep(referenceExpr)); } catch (e) { return { status: "error", detail: `Couldn't read reference "${referenceExpr}": ${e.message}` }; }

  let left = s, right = r, what;
  try {
    if (mode === "derivative") { right = math.derivative(r, variable); what = `d/d${variable}[${referenceExpr}] = ${right.toString()}`; }
    else if (mode === "antiderivative") { left = math.derivative(s, variable); what = `d/d${variable}[your answer] = ${left.toString()}`; }
    else what = "direct comparison";
  } catch (e) { return { status: "error", detail: `Math engine couldn't differentiate: ${e.message}` }; }

  const res = numericallyEqual(left, right, variablesOf(left, right));
  const texOf = (n) => { try { return n.toTex({ parenthesis: "auto", implicit: "hide" }).replace(/\\cdot(?!\s*[\d.])/g, "\\,"); } catch { return null; } };
  const expectedTex = mode === "derivative" ? texOf(right) : mode === "antiderivative" ? null : texOf(r);
  const yoursTex = mode === "antiderivative" ? texOf(left) : null;
  const extra = { expectedTex, yoursTex, mode };
  if (res.equal === true) return { ...extra, status: "verified", detail: `Math engine confirms it (${what}; matched at 15 random points).` };
  if (res.equal === false) return { ...extra, status: "mismatch",
    detail: `Math engine says these differ (${what}). At ${fmt(res.at)}: yours gives ${+res.a.toPrecision(6)}, expected ${+res.b.toPrecision(6)}.` };
  return { ...extra, status: "inconclusive", detail: "Math engine couldn't test enough points (domain issues), so this wasn't auto-verified." };
}
