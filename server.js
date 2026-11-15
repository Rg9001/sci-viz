// SciViz: a ChatGPT app (Apps SDK / MCP server) for math, physics and chemistry.
// Every figure is computed or verified on the server: RDKit + PubChem for chemistry,
// math.js for graphs, so the pictures don't depend on numbers the model made up.
import express from "express";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { checkMath } from "./checker.js";
import { addAttempt, getAttempts, summarize, persistent } from "./store.js";
import * as chem from "./chem.js";
import * as mv from "./mathviz.js";

const WIDGET_URI = "ui://widget/sciviz-v2.html";
const widgetHtml = readFileSync(new URL("./widget.html", import.meta.url), "utf8");

// Every tool carries this so ChatGPT only uses the app for these subjects.
const SCOPE =
  " SCOPE — use this tool ONLY for mathematics (arithmetic, algebra, geometry, trigonometry, " +
  "precalculus, calculus, multivariable calculus, linear algebra, differential equations, statistics), " +
  "physics, and chemistry (general, organic, physical, analytical). NEVER use it for biology, " +
  "microbiology, anatomy, physiology, biochemistry, psychology, neuroscience, economics, history, " +
  "English, or any other subject — not even when the user is practicing, submitting work, or asks " +
  "to be graded in those subjects. For those, just answer normally without this app.";

const widgetMeta = (invoking, invoked) => ({
  "openai/outputTemplate": WIDGET_URI,
  "openai/widgetAccessible": false,
  "openai/resultCanProduceWidget": true,
  "openai/toolInvocation/invoking": invoking,
  "openai/toolInvocation/invoked": invoked,
});

const SUBJECTS = ["Arithmetic", "Algebra", "Geometry", "Trigonometry", "Precalculus", "Calculus",
  "Multivariable Calculus", "Linear Algebra", "Differential Equations", "Statistics", "Physics",
  "General Chemistry", "Organic Chemistry", "Physical Chemistry", "Analytical Chemistry"];

const fail = (message) => ({ isError: true, content: [{ type: "text", text: `${message} Fix the input and call the tool again.` }] });
const guarded = (fn) => async (args) => {
  try { return await fn(args); } catch (e) {
    if (e instanceof chem.ChemError || e instanceof mv.MathError) return fail(e.message);
    console.error(e);
    return fail(`Internal error: ${e.message}.`);
  }
};

const compoundRef = z.object({
  name: z.string().optional().describe("The compound's real chemical name (e.g. 'caffeine', 'L-alanine', '2-bromopropane'). It is checked against PubChem and the structure is corrected if it doesn't match. Leave empty for unnamed intermediates."),
  smiles: z.string().optional().describe("SMILES. Optional when `name` is a real compound name: the exact structure is then taken from PubChem."),
  label: z.string().optional().describe("Free caption that is NOT checked, e.g. 'Product A', 'Intermediate', 'Major product'."),
});

async function resolveCompound(c) {
  if (!c.name && !c.smiles) throw new chem.ChemError("Each compound needs a `name` or a `smiles`.");
  if (c.smiles && c.smiles.includes(">")) throw new chem.ChemError(`"${c.smiles}" is a reaction SMILES; use draw_reaction for reactions.`);
  const check = c.name ? await chem.verifyNamed(c.name, c.smiles) : { status: "unchecked", smiles: c.smiles };
  if (!check.smiles) throw new chem.ChemError(`No structure for "${c.name}": PubChem has no compound by that name, so give a SMILES.`);
  const d = await chem.depict(check.smiles);
  return { name: c.name, label: c.label, light: d.light, dark: d.dark, formula: d.formula, mw: d.mw, smiles: d.canonical,
    counts: chem.elementCounts(d.graph), check: { status: check.status, detail: check.detail, cid: check.cid } };
}

const checkNote = (items) => items.filter((m) => m.check.status === "corrected")
  .map((m) => `CORRECTION: ${m.check.detail} Tell the user the structure was corrected.`).join(" ");

function createServer() {
  const server = new McpServer({ name: "sciviz", version: "2.0.0" });

  server.registerResource("sciviz-widget", WIDGET_URI, {}, async () => ({
    contents: [{
      uri: WIDGET_URI,
      mimeType: "text/html+skybridge",
      text: widgetHtml,
      _meta: {
        "openai/widgetDescription": "Renders verified chemical structures, mechanisms, computed math graphs and grading report cards.",
        "openai/widgetPrefersBorder": true,
        "openai/widgetCSP": { connect_domains: [], resource_domains: ["https://cdn.jsdelivr.net"] },
      },
    }],
  }));

  // ---------- Molecules ----------
  server.registerTool("draw_molecules", {
    title: "Draw chemical structures",
    description:
      "Draw publication-quality skeletal structures (RDKit), with formula and molar mass. Use instead of " +
      "generating images whenever a chemistry structure helps. For known compounds pass `name` (PubChem " +
      "supplies or verifies the exact structure, including stereochemistry). For unnamed species pass " +
      "`smiles` and a `label`. Invalid SMILES are rejected with an explanation." + SCOPE,
    inputSchema: {
      title: z.string().optional(),
      molecules: z.array(compoundRef).min(1).max(8),
      caption: z.string().optional(),
    },
    _meta: widgetMeta("Drawing structures…", "Structures drawn"),
    annotations: { readOnlyHint: true },
  }, guarded(async (args) => {
    const items = await Promise.all(args.molecules.map(resolveCompound));
    return {
      content: [{ type: "text", text: "Drew: " + items.map((m) => `${m.name || m.label || m.smiles} (${m.formula}, ${m.mw} g/mol, ${m.check.status})`).join("; ") + ". " + checkNote(items) }],
      structuredContent: { kind: "molecules", title: args.title, caption: args.caption, items: items.map(({ counts, ...m }) => m) },
    };
  }));

  // ---------- Reactions ----------
  server.registerTool("draw_reaction", {
    title: "Draw a reaction",
    description:
      "Draw a reaction scheme: reactants → products with reagents above the arrow and conditions below. " +
      "Structures are verified like draw_molecules, and the server reports whether atoms and charge are " +
      "balanced. Put reagents as text (e.g. '1. BH3·THF  2. H2O2, NaOH'), not as structures." + SCOPE,
    inputSchema: {
      title: z.string().optional(),
      reactants: z.array(compoundRef).min(1).max(4),
      products: z.array(compoundRef).min(1).max(4),
      reagents: z.string().optional().describe("Text above the arrow"),
      conditions: z.string().optional().describe("Text below the arrow, e.g. 'heat', '0 °C', 'hv'"),
      arrow: z.enum(["forward", "equilibrium"]).optional(),
      caption: z.string().optional(),
    },
    _meta: widgetMeta("Drawing reaction…", "Reaction drawn"),
    annotations: { readOnlyHint: true },
  }, guarded(async (args) => {
    const reactants = await Promise.all(args.reactants.map(resolveCompound));
    const products = await Promise.all(args.products.map(resolveCompound));
    const bal = chem.balance(reactants.map((m) => m.counts), products.map((m) => m.counts));
    const balText = bal.balanced ? "Atoms and charge are balanced." :
      `Not balanced as drawn (product side minus reactant side: ${Object.entries(bal.diff).map(([k, v]) => `${v > 0 ? "+" : ""}${v} ${k}`).join(", ") || "atoms OK"}${bal.chargeDiff ? `, charge ${bal.chargeDiff > 0 ? "+" : ""}${bal.chargeDiff}` : ""}). Fine if only the major organic product is shown; otherwise fix the equation.`;
    const strip = ({ counts, ...m }) => m;
    return {
      content: [{ type: "text", text: `Drew reaction. ${balText} ` + checkNote([...reactants, ...products]) }],
      structuredContent: { kind: "reaction", title: args.title, caption: args.caption, reagents: args.reagents, conditions: args.conditions,
        arrow: args.arrow || "forward", reactants: reactants.map(strip), products: products.map(strip), balanced: bal.balanced },
    };
  }));

  // ---------- Mechanisms ----------
  const atomRef = z.union([z.number().int().min(0), z.array(z.number().int().min(0)).length(2)]);
  server.registerTool("draw_mechanism", {
    title: "Draw reaction mechanism",
    description:
      "Draw an organic mechanism step by step with curved electron-pushing arrows. Each step = the species " +
      "present (SMILES, species separated by '.') + the arrows for what happens next. ATOM INDICES: atoms " +
      "are numbered 0,1,2… in the order they appear in that step's SMILES, counting every atom written " +
      "(bracket atoms like [H], [OH-], [H+] count; implicit hydrogens do not; '.' does not reset). Write any " +
      "hydrogen that moves explicitly as [H]. Arrow endpoints: an atom index (a lone pair, or the atom " +
      "attacked) or [i, j] for the bond between atoms i and j. Arrows must start at a lone pair or a bond — " +
      "the server checks this and rejects bad indices, so recount if it errors. type 'fishhook' = one-electron " +
      "arrow. Write water as [OH2]. The last step normally shows products without arrows." + SCOPE,
    inputSchema: {
      title: z.string().optional(),
      steps: z.array(z.object({
        smiles: z.string(),
        arrows: z.array(z.object({ from: atomRef, to: atomRef, type: z.enum(["full", "fishhook"]).optional() })).max(6).optional(),
        label: z.string().optional().describe("e.g. 'Step 1: Protonation of the carbonyl'"),
        note: z.string().optional().describe("One-sentence explanation"),
      })).min(1).max(8),
      caption: z.string().optional(),
      showAtomNumbers: z.boolean().optional(),
    },
    _meta: widgetMeta("Drawing mechanism…", "Mechanism drawn"),
    annotations: { readOnlyHint: true },
  }, guarded(async (args) => {
    const steps = [];
    for (let i = 0; i < args.steps.length; i++) {
      const st = args.steps[i];
      const d = await chem.mechanismStep(st.smiles, st.arrows || [], i + 1, !!args.showAtomNumbers);
      steps.push({ label: st.label, note: st.note, light: d.light, dark: d.dark, formula: d.formula, counts: chem.elementCounts(d.graph) });
    }
    const notes = [];
    for (let i = 1; i < steps.length; i++) {
      const b = chem.balance([steps[i - 1].counts], [steps[i].counts]);
      if (!b.balanced) notes.push(`Between step ${i} and ${i + 1} the atoms/charge change (${Object.entries(b.diff).map(([k, v]) => `${v > 0 ? "+" : ""}${v} ${k}`).join(", ")}${b.chargeDiff ? `, charge ${b.chargeDiff > 0 ? "+" : ""}${b.chargeDiff}` : ""}) — make sure a species added/lost (e.g. H+, H2O) is mentioned in the note.`);
    }
    return {
      content: [{ type: "text", text: `Drew a ${steps.length}-step mechanism; all arrows start at real lone pairs or bonds. ${notes.join(" ")}` }],
      structuredContent: { kind: "mechanism", title: args.title, caption: args.caption, steps: steps.map(({ counts, ...s }) => s) },
    };
  }));

  // ---------- 2D plots ----------
  server.registerTool("plot_functions", {
    title: "Plot functions",
    description:
      "Plot y = f(x) curves. The server COMPUTES everything: discontinuities, and on request roots, " +
      "local extrema, inflection points, asymptotes and the y-intercept (`features`), exact tangent lines " +
      "(`tangentAt`) and shaded definite integrals with their value (`shadeFrom`/`shadeTo`). Always prefer " +
      "these over hand-computed points or tangent equations. Values are shown in exact form (π/2, √3, 2/3) " +
      "when exact. math.js syntax in x: 'x^3 - 3x', 'sin(x)/x', 'e^(-x^2)', 'log(x)' (natural log)." + SCOPE,
    inputSchema: {
      title: z.string().optional(),
      functions: z.array(z.object({
        expr: z.string(),
        label: z.string().optional(),
        features: z.array(z.enum(["roots", "extrema", "inflection", "asymptotes", "y_intercept"])).optional(),
        tangentAt: z.number().optional(),
        shadeFrom: z.number().optional(), shadeTo: z.number().optional(),
        dashed: z.boolean().optional(),
      })).min(1).max(6),
      points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().optional(),
        onCurve: z.boolean().optional().describe("Default true: the point is checked to lie on a curve") })).optional(),
      xMin: z.number().optional(), xMax: z.number().optional(),
      yMin: z.number().optional(), yMax: z.number().optional(),
      xLabel: z.string().optional(), yLabel: z.string().optional(),
      caption: z.string().optional(),
    },
    _meta: widgetMeta("Plotting…", "Plotted"),
    annotations: { readOnlyHint: true },
  }, guarded(async (args) => {
    const x0 = args.xMin ?? -10, x1 = args.xMax ?? 10;
    if (!(x1 > x0)) throw new mv.MathError("xMax must be greater than xMin.");
    const fns = args.functions.map((f) => ({ ...mv.analyzeFunction(f, x0, x1), label: f.label, dashed: f.dashed }));
    const points = mv.checkPoints(args.points || [], args.functions.map((f) => mv.makeFn(mv.parseExpr(f.expr))));
    const bad = points.filter((p) => !p.ok);
    const lo = Math.min(...fns.map((f) => f.range[0])), hi = Math.max(...fns.map((f) => f.range[1]));
    const feat = fns.flatMap((f, i) => f.features.map((p) => `${p.kind} ${p.text}` + (fns.length > 1 ? ` on f${i + 1}` : "")));
    const text = [
      `Plotted ${fns.map((f) => f.expr).join("; ")}.`,
      feat.length ? `Computed features: ${feat.join("; ")}.` : "",
      ...fns.flatMap((f) => f.lines.map((l) => `${l.kind}: ${l.text}.`)),
      ...fns.filter((f) => f.tangent).map((f) => `Tangent at x=${f.tangent.x0}: slope ${mv.nice(f.tangent.slope).text}, ${f.tangent.tex}.`),
      ...fns.filter((f) => f.shade).map((f) => `Integral from ${f.shade.from} to ${f.shade.to} = ${Number.isFinite(f.shade.value) ? mv.nice(f.shade.value).text : "undefined"}.`),
      ...fns.flatMap((f) => f.warnings),
      ...bad.map((p) => `WARNING: point (${p.x}, ${p.y}) "${p.label || ""}" is NOT on the curve${p.actual != null ? ` (f(${p.x}) = ${mv.nice(p.actual).text})` : ""}; correct what you tell the user.`),
    ].filter(Boolean).join(" ");
    return {
      content: [{ type: "text", text }],
      structuredContent: { kind: "plot2d", title: args.title, caption: args.caption, xLabel: args.xLabel, yLabel: args.yLabel,
        xRange: [x0, x1], yRange: args.yMin != null && args.yMax != null ? [args.yMin, args.yMax] : [lo, hi],
        functions: fns.map(({ range, warnings, ...f }) => f), points },
    };
  }));

  // ---------- 3D surfaces ----------
  server.registerTool("plot_surface", {
    title: "Plot 3D surface",
    description: "Interactive rotatable 3D surface z = f(x, y) with contours, for multivariable calculus. math.js syntax in x and y." + SCOPE,
    inputSchema: {
      title: z.string().optional(), expr: z.string(),
      xMin: z.number().optional(), xMax: z.number().optional(), yMin: z.number().optional(), yMax: z.number().optional(),
      caption: z.string().optional(),
    },
    _meta: widgetMeta("Building surface…", "Surface ready"),
    annotations: { readOnlyHint: true },
  }, guarded(async (a) => {
    const s = mv.sampleSurface(a.expr, a.xMin ?? -5, a.xMax ?? 5, a.yMin ?? -5, a.yMax ?? 5);
    return { content: [{ type: "text", text: `Plotted surface z = ${a.expr}.` }],
      structuredContent: { kind: "plot3d", title: a.title, caption: a.caption, ...s } };
  }));

  // ---------- Animations ----------
  server.registerTool("animate_concept", {
    title: "Animate a calculus concept",
    description:
      "Interactive animation with slider and play button: 'riemann' (Riemann sums → definite integral; " +
      "needs a, b; method left/right/midpoint/trapezoid), 'secant_tangent' (secant lines → tangent at x0), " +
      "'limit' (x → x0 from both sides with a value table). math.js syntax in x." + SCOPE,
    inputSchema: {
      type: z.enum(["riemann", "secant_tangent", "limit"]), expr: z.string(),
      a: z.number().optional(), b: z.number().optional(),
      method: z.enum(["left", "right", "midpoint", "trapezoid"]).optional(),
      x0: z.number().optional(), xMin: z.number().optional(), xMax: z.number().optional(),
      title: z.string().optional(), caption: z.string().optional(),
    },
    _meta: widgetMeta("Building animation…", "Animation ready"),
    annotations: { readOnlyHint: true },
  }, guarded(async (args) => {
    const node = mv.parseExpr(args.expr);
    if (args.type === "riemann" && (args.a == null || args.b == null || !(args.b > args.a))) throw new mv.MathError("Riemann sums need a < b.");
    if (args.type !== "riemann" && args.x0 == null) throw new mv.MathError(`${args.type} needs x0.`);
    let extra = "";
    if (args.type === "riemann") {
      const v = mv.integrate(mv.makeFn(node), args.a, args.b);
      extra = ` Exact integral ${Number.isFinite(v) ? mv.nice(v).text : "undefined (improper)"}.`;
    }
    return { content: [{ type: "text", text: `Showing an interactive ${args.type} animation for ${args.expr}.${extra}` }],
      structuredContent: { kind: "animate", ...args, expr: mv.prep(args.expr), tex: mv.toTex(node) } };
  }));

  // ---------- Grading ----------
  server.registerTool("grade_work", {
    title: "Grade my work",
    description:
      "Grade the student's own attempt at a MATH, PHYSICS or CHEMISTRY problem and show a report card. Use " +
      "when the user submits work or an answer (typed or a photo) in one of those subjects and wants to know " +
      "if it's right. First solve the problem yourself carefully, then grade each step. Be encouraging but " +
      "honest. Whenever the final answer is an expression or number ALWAYS fill mathCheck so a math engine " +
      "verifies it. For organic chemistry fill structures (student's and correct product) so RDKit can compare " +
      "them. If the tool reports a disagreement, re-examine and tell the student the corrected result." + SCOPE,
    inputSchema: {
      subject: z.enum(SUBJECTS).describe("Must be one of these; other subjects are out of scope"),
      problem: z.string(),
      verdict: z.enum(["correct", "partially_correct", "incorrect"]),
      score: z.number().min(0).max(100),
      studentAnswer: z.string(),
      correctAnswer: z.string(),
      steps: z.array(z.object({
        work: z.string(), status: z.enum(["correct", "minor_error", "incorrect"]), feedback: z.string(),
      })).max(15).optional(),
      mathCheck: z.object({
        mode: z.enum(["equivalent", "derivative", "antiderivative"])
          .describe("equivalent: student == reference. derivative: student == d/dx(reference). antiderivative: d/dx(student) == reference"),
        studentExpr: z.string(), referenceExpr: z.string(), variable: z.string().optional(),
      }).optional(),
      structures: z.object({ studentSmiles: z.string().optional(), correctSmiles: z.string().optional() }).optional(),
      keyConcept: z.string().optional(),
      topic: z.string().describe("Short consistent topic name for the progress tracker, e.g. 'Chain rule', 'SN2'"),
      hint: z.string().optional(),
      nextProblem: z.string().optional(),
    },
    _meta: widgetMeta("Grading your work…", "Graded"),
    annotations: { readOnlyHint: false },
  }, guarded(async (args) => {
    const notes = [], blockers = [];
    const check = args.mathCheck ? checkMath(args.mathCheck) : null;
    if (check?.status === "mismatch" && args.verdict === "correct") blockers.push(`The math engine proves the student's final answer is NOT equal to the correct one (${check.detail}), so the verdict cannot be 'correct'.`);
    if (check?.status === "verified" && args.verdict === "incorrect") notes.push("NOTE: the math engine says the student's answer IS equivalent to the reference. If it was marked wrong only for form, say so; otherwise re-check.");

    let structures = null;
    if (args.structures?.studentSmiles || args.structures?.correctSmiles) {
      structures = {};
      for (const k of ["studentSmiles", "correctSmiles"]) if (args.structures[k]) {
        const d = await chem.depict(args.structures[k]);
        structures[k === "studentSmiles" ? "student" : "correct"] = { light: d.light, dark: d.dark, formula: d.formula, smiles: d.canonical };
      }
      if (structures.student && structures.correct) {
        const same = structures.student.smiles === structures.correct.smiles;
        structures.same = same;
        if (same && args.verdict === "incorrect") blockers.push("RDKit shows the student's structure is IDENTICAL to the correct one, so the verdict cannot be 'incorrect'.");
        if (!same && args.verdict === "correct") blockers.push(`RDKit shows the student's structure (${structures.student.smiles}) DIFFERS from the correct one (${structures.correct.smiles}), so the verdict cannot be 'correct'.`);
      }
    }
    // Never show a verdict that a deterministic check has proven wrong.
    if (blockers.length) throw new chem.ChemError(`Grade rejected: ${blockers.join(" ")} Re-solve the problem, double-check the correct answer, and grade again.`);
    const tex = (s) => { try { return mv.toTex(mv.parseExpr(s, ["x", "y", "z", "t", "n", "C", "k", "a", "b"])); } catch { return null; } };

    let progressNote = "";
    try {
      await addAttempt({ ts: Date.now(), subject: args.subject, topic: args.topic, score: args.score, verdict: args.verdict, problem: String(args.problem).slice(0, 160) });
      const t = summarize(await getAttempts()).topics.find((x) => x.topic === args.topic);
      if (t) progressNote = ` Progress on '${t.topic}': avg ${t.avg}/100 over ${t.attempts} attempt(s).`;
    } catch (e) { console.error("progress log failed", e); }
    return {
      content: [{ type: "text", text: `Graded: ${args.verdict} (${args.score}/100).` + (check ? ` Math engine: ${check.status} — ${check.detail}` : "") + " " + notes.join(" ") + progressNote }],
      structuredContent: { kind: "grade", ...args, structures, check, studentTex: tex(args.studentAnswer), correctTex: tex(args.correctAnswer) },
    };
  }));

  // ---------- Progress ----------
  server.registerTool("show_progress", {
    title: "Show my progress",
    description: "Show the student's math/physics/chemistry study dashboard: graded attempts, average score, streak, per-topic scores and weakest topics. Afterwards offer practice on the weakest topics." + SCOPE,
    inputSchema: { subject: z.string().optional().describe("Filter, e.g. 'Calculus' or 'Organic'") },
    _meta: widgetMeta("Loading your progress…", "Progress loaded"),
    annotations: { readOnlyHint: true },
  }, guarded(async ({ subject }) => {
    const stats = summarize(await getAttempts(), { subject });
    const weak = stats.weakTopics.map((t) => `${t.topic} (${t.avg})`).join(", ") || "none yet";
    return {
      content: [{ type: "text", text: `${stats.total} graded attempts, avg ${stats.avgScore}/100, ${stats.accuracy}% fully correct, streak ${stats.streak} day(s). Weakest topics: ${weak}.` + (persistent ? "" : " (Storage is temporary: history resets when the server restarts.)") }],
      structuredContent: { kind: "progress", subject, ...stats },
    };
  }));

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.get("/mcp", (_req, res) => res.status(405).send("Use POST"));
app.get("/", (_req, res) => res.send("SciViz MCP server is running. Endpoint: /mcp"));

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`SciViz MCP server on http://localhost:${PORT}/mcp`));
