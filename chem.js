// Chemistry engine: RDKit for validation + publication-quality depiction,
// PubChem for checking that a named compound really has the drawn structure.
import initRDKitModule from "@rdkit/rdkit";

let rdkitPromise;
const rdkit = () => (rdkitPromise ??= initRDKitModule());

export class ChemError extends Error {}

// ---------- Colors ----------
const LIGHT = {
  "-1": [0.1, 0.1, 0.12], 1: [0.1, 0.1, 0.12], 6: [0.1, 0.1, 0.12], 7: [0.18, 0.36, 0.83], 8: [0.84, 0.2, 0.17],
  9: [0.18, 0.62, 0.27], 15: [0.85, 0.47, 0.12], 16: [0.71, 0.54, 0.0], 17: [0.18, 0.62, 0.27],
  35: [0.61, 0.29, 0.11], 53: [0.48, 0.25, 0.63], 5: [0.8, 0.45, 0.45], 11: [0.48, 0.25, 0.63], 3: [0.48, 0.25, 0.63],
};
const DARK = {
  "-1": [0.93, 0.93, 0.95], 1: [0.93, 0.93, 0.95], 6: [0.93, 0.93, 0.95], 7: [0.49, 0.65, 1.0], 8: [1.0, 0.45, 0.42],
  9: [0.45, 0.85, 0.5], 15: [1.0, 0.65, 0.3], 16: [1.0, 0.85, 0.35], 17: [0.45, 0.85, 0.5],
  35: [0.95, 0.55, 0.35], 53: [0.78, 0.55, 0.95], 5: [1.0, 0.65, 0.65], 11: [0.78, 0.55, 0.95], 3: [0.78, 0.55, 0.95],
};
export const ARROW = { light: "#E0245E", dark: "#FF6B8B" };

const SYMBOL = ["", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar",
  "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr",
  "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Sb", "Te", "I", "Xe", "Cs", "Ba"];
const VALENCE_E = { 1: 1, 3: 1, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 7, 34: 6, 35: 7, 53: 7 };

const BL = 34; // bond length in px

// ---------- Molecule parsing & info ----------
async function parseMol(smiles) {
  const R = await rdkit();
  const s = String(smiles || "").trim();
  if (!s) throw new ChemError("Empty SMILES.");
  // Keep explicit [H] atoms so atom indices match the SMILES exactly (needed for arrows to H).
  const mol = R.get_mol(s, JSON.stringify({ removeHs: false }));
  if (!mol || !mol.is_valid()) {
    mol?.delete?.();
    throw new ChemError(`"${s}" is not a valid SMILES string (RDKit could not parse it; check ring closures, brackets and valences).`);
  }
  return mol;
}

function graphOf(mol) {
  const j = JSON.parse(mol.get_json());
  const da = j.defaults.atom, db = j.defaults.bond;
  const m = j.molecules[0];
  const atoms = m.atoms.map((a) => ({ z: a.z ?? da.z, impHs: a.impHs ?? da.impHs, chg: a.chg ?? da.chg, nRad: a.nRad ?? da.nRad }));
  const bonds = (m.bonds || []).map((b) => ({ a: b.atoms[0], b: b.atoms[1], bo: b.bo ?? db.bo }));
  return { atoms, bonds };
}

export function elementCounts(graph) {
  const c = {};
  let charge = 0;
  for (const a of graph.atoms) {
    const s = SYMBOL[a.z] || `Z${a.z}`;
    c[s] = (c[s] || 0) + 1;
    if (a.impHs) c.H = (c.H || 0) + a.impHs;
    charge += a.chg;
  }
  return { counts: c, charge };
}

function hill({ counts, charge }) {
  const keys = Object.keys(counts);
  const order = counts.C ? ["C", "H", ...keys.filter((k) => k !== "C" && k !== "H").sort()] : keys.sort();
  const f = order.filter((k) => counts[k]).map((k) => k + (counts[k] > 1 ? counts[k] : "")).join("");
  const q = charge === 0 ? "" : (Math.abs(charge) > 1 ? Math.abs(charge) : "") + (charge > 0 ? "+" : "−");
  return f + q;
}

async function infoOf(mol) {
  const R = await rdkit();
  const graph = graphOf(mol);
  let inchikey = null;
  try { const inchi = mol.get_inchi(); if (inchi) inchikey = R.get_inchikey_for_inchi(inchi); } catch { /* some species have no InChI */ }
  const desc = JSON.parse(mol.get_descriptors());
  return {
    canonical: mol.get_smiles(),
    formula: hill(elementCounts(graph)),
    mw: Math.round(desc.amw * 1000) / 1000,
    inchikey,
    hasStereo: /[@\/\\]/.test(mol.get_smiles()),
    graph,
  };
}

// ---------- Depiction ----------
const SENTINEL = [0.123, 0.456, 0.789];
const hex = (c) => "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
const paletteHex = (pal, z) => hex(pal[z] || pal["-1"]);

function readMolblock(mb) {
  const lines = mb.split("\n");
  const n = parseInt(lines[3].slice(0, 3), 10);
  return { lines, n, xy: lines.slice(4, 4 + n).map((l) => [parseFloat(l.slice(0, 10)), parseFloat(l.slice(10, 20))]) };
}
function writeMolblock({ lines, n }, xy) {
  const out = lines.slice();
  for (let i = 0; i < n; i++) {
    const l = out[4 + i];
    out[4 + i] = xy[i][0].toFixed(4).padStart(10) + xy[i][1].toFixed(4).padStart(10) + l.slice(20);
  }
  return out.join("\n");
}

function components(graph) {
  const n = graph.atoms.length, comp = new Array(n).fill(-1);
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (comp[i] !== -1) continue;
    const stack = [i]; comp[i] = c;
    while (stack.length) {
      const v = stack.pop();
      for (const b of graph.bonds) {
        const w = b.a === v ? b.b : b.b === v ? b.a : -1;
        if (w >= 0 && comp[w] === -1) { comp[w] = c; stack.push(w); }
      }
    }
    c++;
  }
  return { comp, count: c };
}

/** Lay fragments out left-to-right (SMILES order); rotate fragments 180° so arrow partners face each other. */
function layoutFragments(xy, graph, arrows) {
  const { comp, count } = components(graph);
  if (count < 2) return xy;
  const frags = [...Array(count).keys()].map((f) => xy.map((p, i) => i).filter((i) => comp[i] === f));
  const center = (ids, pts) => {
    const xs = ids.map((i) => pts[i][0]), ys = ids.map((i) => pts[i][1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  };
  const place = (rot) => {
    const pts = xy.map((p) => p.slice());
    let cursor = 0;
    frags.forEach((ids, f) => {
      const [cx, cy] = center(ids, xy);
      for (const i of ids) { let x = xy[i][0] - cx, y = xy[i][1] - cy; if (rot[f]) { x = -x; y = -y; } pts[i] = [x, y]; }
      const xs = ids.map((i) => pts[i][0]);
      const shift = cursor - Math.min(...xs);
      for (const i of ids) pts[i][0] += shift;
      cursor = Math.max(...ids.map((i) => pts[i][0])) + 1.9;
    });
    return pts;
  };
  const ends = (e) => (Array.isArray(e) ? e : [e]);
  const cost = (pts) => {
    let c = 0;
    for (const ar of arrows || []) for (const a of ends(ar.from)) for (const b of ends(ar.to)) {
      if (comp[a] !== comp[b]) c += Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
    }
    return c;
  };
  let best = null;
  const k = Math.min(count, 5);
  for (let mask = 0; mask < 1 << k; mask++) {
    const rot = [...Array(count).keys()].map((f) => f < k && (mask >> f) & 1);
    const pts = place(rot), c = cost(pts);
    if (!best || c < best.c - 1e-9) best = { c, pts };
  }
  return best.pts;
}

function render(mol, graph, theme, { atomNumbers = false, width, height }) {
  const n = mol.get_num_atoms();
  const pal = theme === "dark" ? DARK : LIGHT;
  const opts = {
    width, height,
    fixedBondLength: BL,
    bondLineWidth: 1.6,
    scaleBondWidth: false,
    multipleBondOffset: 0.16,
    padding: 0.06,
    additionalAtomLabelPadding: 0.08,
    addAtomIndices: atomNumbers,
    addStereoAnnotation: false,
    clearBackground: false,
    backgroundColour: [0, 0, 0, 0],
    atomColourPalette: pal,
    annotationColour: theme === "dark" ? [0.55, 0.7, 1] : [0.15, 0.35, 0.85],
    // Highlight every atom in a sentinel colour so RDKit reports each atom's exact centre.
    // The ellipses are deleted and the sentinel colour is replaced with the real element colours.
    atoms: [...Array(n).keys()],
    bonds: [],
    highlightRadius: 0.05,
    highlightColour: SENTINEL,
  };
  let svg = mol.get_svg_with_highlights(JSON.stringify(opts));
  const atoms = new Array(n);
  svg = svg.replace(/<ellipse cx='([\d.-]+)' cy='([\d.-]+)'[^>]*class='atom-(\d+)'[^>]*\/>\n?/g, (_, x, y, i) => {
    if (!atoms[+i]) atoms[+i] = { x: +x, y: +y };
    return "";
  });
  if (atoms.some((a) => !a) || atoms.length !== n) throw new ChemError("Internal drawing error: couldn't locate every atom.");
  const labeled = new Set([...svg.matchAll(/<path class='atom-(\d+)'/g)].map((m) => +m[1]));
  atoms.forEach((a, i) => { a.labeled = labeled.has(i); });
  // Highlighting changes RDKit's colours (and stops it splitting hetero bonds into two coloured halves),
  // so colour every atom label and bond half by element ourselves.
  const colourOf = (i) => paletteHex(pal, graph.atoms[i].z);
  const paint = (attrs, col) => attrs.replace(/(fill|stroke):#[0-9A-Fa-f]{6}/g, `$1:${col}`).replace(/(fill|stroke)='#[0-9A-Fa-f]{6}'/g, `$1='${col}'`);
  const dist = (i, x, y) => Math.hypot(atoms[i].x - x, atoms[i].y - y);
  svg = svg.replace(/<path class='([^']*)' d='([^']*)'([^>]*)>/g, (whole, cls, d, rest) => {
    const label = cls.match(/^atom-(\d+)$/);
    if (label) return `<path class='${cls}' d='${d}'${paint(rest, colourOf(+label[1]))}>`;
    const m = cls.match(/^bond-\d+ atom-(\d+) atom-(\d+)/);
    if (!m) return whole;
    const [p, q] = [+m[1], +m[2]];
    const line = d.trim().match(/^M ([\d.-]+),([\d.-]+) L ([\d.-]+),([\d.-]+)$/);
    if (line) {
      const [x1, y1, x2, y2] = line.slice(1).map(Number);
      const startAtom = dist(p, x1, y1) + dist(q, x2, y2) <= dist(q, x1, y1) + dist(p, x2, y2) ? p : q;
      const endAtom = startAtom === p ? q : p;
      const c1 = colourOf(startAtom), c2 = colourOf(endAtom);
      if (c1 === c2) return `<path class='${cls}' d='${d}'${paint(rest, c1)}>`;
      const mx = ((x1 + x2) / 2).toFixed(1), my = ((y1 + y2) / 2).toFixed(1);
      return `<path class='${cls}' d='M ${x1},${y1} L ${mx},${my}'${paint(rest, c1)}>` +
        `<path class='${cls}' d='M ${mx},${my} L ${x2},${y2}'${paint(rest, c2)}>`;
    }
    // Wedges and other shapes: colour by the nearest atom to the shape's start.
    const nums = d.match(/-?[\d.]+/g).map(Number);
    const near = dist(p, nums[0], nums[1]) <= dist(q, nums[0], nums[1]) ? p : q;
    return `<path class='${cls}' d='${d}'${paint(rest, colourOf(near))}>`;
  });
  svg = svg.replace(/<\?xml[^>]*>\s*/, "").replace(/<!-- END OF HEADER -->\s*/, "").replace(/<rect[^>]*>\s*<\/rect>\s*/, "");
  return { svg, atoms };
}

/** Depict a SMILES (possibly multi-fragment) in both themes. */
export async function depict(smiles, { atomNumbers = false, arrows = [] } = {}) {
  const R = await rdkit();
  let mol = await parseMol(smiles);
  try {
    const original = await infoOf(mol);
    mol.set_new_coords(true);
    try { mol.straighten_depiction(); } catch { /* optional */ }
    const mb = readMolblock(mol.get_molblock());
    const xy = layoutFragments(mb.xy, original.graph, arrows);
    // Rebuild from the re-laid-out molblock; keep it only if the structure (incl. stereo) is unchanged.
    const rebuilt = R.get_mol(writeMolblock(mb, xy), JSON.stringify({ removeHs: false }));
    if (rebuilt && rebuilt.is_valid() && rebuilt.get_smiles() === original.canonical) { mol.delete(); mol = rebuilt; }
    else rebuilt?.delete?.();
    const pts = readMolblock(mol.get_molblock()).xy;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const width = Math.round(Math.max(150, (Math.max(...xs) - Math.min(...xs)) * BL + 90));
    const height = Math.round(Math.max(110, (Math.max(...ys) - Math.min(...ys)) * BL + 80));
    const light = render(mol, original.graph, "light", { atomNumbers, width, height });
    const dark = render(mol, original.graph, "dark", { atomNumbers, width, height });
    return { light: light.svg, dark: dark.svg, atoms: light.atoms, width, height, ...original };
  } finally { mol.delete(); }
}

export async function canonicalize(smiles) {
  const mol = await parseMol(smiles);
  try { return await infoOf(mol); } finally { mol.delete(); }
}

// ---------- PubChem ----------
const cache = new Map();
export async function pubchem(name) {
  const key = name.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(name.trim())}/property/SMILES,IUPACName,MolecularFormula,InChIKey/JSON`;
  let result = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const p = (await res.json()).PropertyTable?.Properties?.[0];
      if (p?.SMILES) result = { cid: p.CID, smiles: p.SMILES, iupac: p.IUPACName, formula: p.MolecularFormula, inchikey: p.InChIKey };
    } else if (res.status === 404) result = null;
    else return { error: `PubChem HTTP ${res.status}` };
  } catch (e) { return { error: `PubChem unreachable (${e.name})` }; }
  cache.set(key, result);
  return result;
}

/**
 * Check a named structure against PubChem. Returns
 *  { status: 'verified' | 'corrected' | 'not_found' | 'unchecked', smiles, detail, cid }
 */
export async function verifyNamed(name, smiles) {
  if (!name) return { status: "unchecked", smiles };
  const hit = await pubchem(name);
  if (!hit) return { status: "not_found", smiles, detail: `No PubChem compound is named "${name}".` };
  if (hit.error) return { status: "unchecked", smiles, detail: hit.error };
  if (!smiles) return { status: "verified", smiles: hit.smiles, cid: hit.cid, detail: `Structure taken from PubChem (CID ${hit.cid}).`, fromPubchem: true };
  const mine = await canonicalize(smiles);
  if (!mine.inchikey || !hit.inchikey) return { status: "unchecked", smiles, detail: "Couldn't compute an InChIKey to compare." };
  if (mine.inchikey === hit.inchikey) return { status: "verified", smiles, cid: hit.cid, detail: `Matches PubChem CID ${hit.cid}.` };
  const sameSkeleton = mine.inchikey.slice(0, 14) === hit.inchikey.slice(0, 14);
  const why = !sameSkeleton ? "a different structure"
    : mine.inchikey.slice(15, 25) !== hit.inchikey.slice(15, 25) ? (mine.hasStereo ? "the wrong stereochemistry" : "no stereochemistry")
      : "a different protonation state";
  return { status: "corrected", smiles: hit.smiles, cid: hit.cid, given: smiles,
    detail: `The SMILES given for "${name}" had ${why}; replaced with PubChem CID ${hit.cid} (${hit.smiles}).` };
}

// ---------- Reactions ----------
export function splitReaction(rxn) {
  const parts = String(rxn).split(">");
  if (parts.length !== 3) throw new ChemError(`Reaction SMILES must look like "reactants>agents>products"; got "${rxn}".`);
  const comps = (s) => s.split(".").map((x) => x.trim()).filter(Boolean);
  return { reactants: comps(parts[0]), agents: comps(parts[1]), products: comps(parts[2]) };
}

export function balance(sideA, sideB) {
  const sum = (list) => {
    const c = {}; let q = 0;
    for (const x of list) { for (const [k, v] of Object.entries(x.counts)) c[k] = (c[k] || 0) + v; q += x.charge; }
    return { c, q };
  };
  const A = sum(sideA), B = sum(sideB);
  const diff = {};
  for (const k of new Set([...Object.keys(A.c), ...Object.keys(B.c)])) if ((A.c[k] || 0) !== (B.c[k] || 0)) diff[k] = (B.c[k] || 0) - (A.c[k] || 0);
  return { balanced: !Object.keys(diff).length && A.q === B.q, diff, chargeDiff: B.q - A.q };
}

// ---------- Mechanism arrows ----------
function lonePairs(atom, graph, idx) {
  const ve = VALENCE_E[atom.z];
  if (ve == null) return 0;
  let bondSum = 0;
  for (const b of graph.bonds) if (b.a === idx || b.b === idx) bondSum += b.bo;
  return (ve - atom.chg - bondSum - atom.impHs - atom.nRad) / 2;
}

/** Validate arrows against chemistry; throws ChemError with a precise message. */
export function validateArrows(arrows, graph, stepNo) {
  const n = graph.atoms.length;
  const where = `Step ${stepNo}`;
  const hasBond = (i, j) => graph.bonds.some((b) => (b.a === i && b.b === j) || (b.a === j && b.b === i));
  const name = (i) => `atom ${i} (${SYMBOL[graph.atoms[i].z]}${graph.atoms[i].chg ? (graph.atoms[i].chg > 0 ? "+" : "−") : ""})`;
  const checkIdx = (i) => { if (!Number.isInteger(i) || i < 0 || i >= n) throw new ChemError(`${where}: atom index ${i} doesn't exist; this step has atoms 0–${n - 1}.`); };
  arrows.forEach((ar, k) => {
    const tag = `${where}, arrow ${k + 1}`;
    for (const end of [ar.from, ar.to]) (Array.isArray(end) ? end : [end]).forEach(checkIdx);
    if (Array.isArray(ar.from)) {
      if (!hasBond(ar.from[0], ar.from[1])) throw new ChemError(`${tag}: starts at the bond [${ar.from}], but ${name(ar.from[0])} and ${name(ar.from[1])} aren't bonded. Arrows must start at an existing bond or a lone pair.`);
    } else {
      const a = graph.atoms[ar.from];
      const lp = lonePairs(a, graph, ar.from);
      const radical = ar.type === "fishhook" && a.nRad > 0;
      if (lp < 1 && !radical) throw new ChemError(`${tag}: starts at ${name(ar.from)}, which has no lone pair. Electrons must come from a lone pair, a negative charge, or a bond — check the atom index.`);
    }
    if (!Array.isArray(ar.to) && !Array.isArray(ar.from) && ar.to === ar.from) throw new ChemError(`${tag}: starts and ends on the same atom.`);
  });
}

function neighbors(graph, i) {
  return graph.bonds.flatMap((b) => (b.a === i ? [b.b] : b.b === i ? [b.a] : []));
}

/** Add curved arrows to an SVG produced by depict(). */
export function drawArrows(svg, atoms, graph, arrows, color, id) {
  if (!arrows.length) return svg;
  const unit = (x, y) => { const L = Math.hypot(x, y) || 1; return { x: x / L, y: y / L }; };
  const P = (i) => atoms[i];
  const clearance = (p) => Math.min(...atoms.map((a) => Math.hypot(a.x - p.x, a.y - p.y)));
  const better = (p, n, d) => {
    const c1 = { x: p.x + n.x * d, y: p.y + n.y * d }, c2 = { x: p.x - n.x * d, y: p.y - n.y * d };
    return clearance(c1) >= clearance(c2) ? n : { x: -n.x, y: -n.y };
  };
  // Direction pointing away from an atom's neighbours (where its lone pairs sit).
  const outward = (i) => {
    const nb = neighbors(graph, i);
    if (!nb.length) {
      const others = atoms.filter((_, k) => k !== i);
      if (!others.length) return { x: 0, y: -1 };
      const cx = others.reduce((s, a) => s + a.x, 0) / others.length, cy = others.reduce((s, a) => s + a.y, 0) / others.length;
      return unit(P(i).x - cx, P(i).y - cy);
    }
    let sx = 0, sy = 0;
    for (const j of nb) { const u = unit(P(j).x - P(i).x, P(j).y - P(i).y); sx += u.x; sy += u.y; }
    if (Math.hypot(sx, sy) < 1e-3) { const u = unit(P(nb[0]).x - P(i).x, P(nb[0]).y - P(i).y); return { x: -u.y, y: u.x }; }
    return unit(-sx, -sy);
  };
  const r = (i) => (P(i).labeled ? 11 : 4);

  let paths = "";
  const pts = [];
  arrows.forEach((ar) => {
    let a, b;
    const bondFrom = Array.isArray(ar.from), bondTo = Array.isArray(ar.to);
    if (bondFrom && !bondTo && ar.from.includes(ar.to)) {
      // Bond electrons moving onto one of the bond's own atoms (e.g. leaving group).
      const t = P(ar.to), o = P(ar.from[0] === ar.to ? ar.from[1] : ar.from[0]);
      const mid = { x: (t.x + o.x) / 2, y: (t.y + o.y) / 2 };
      const n = better(mid, unit(-(t.y - o.y), t.x - o.x), 14);
      const along = unit(t.x - o.x, t.y - o.y);
      a = { x: mid.x + n.x * 4, y: mid.y + n.y * 4 };
      const off = t.labeled ? 13 : 8;
      b = { x: t.x + n.x * off - along.x * 2, y: t.y + n.y * off - along.y * 2 };
    } else {
      if (bondFrom) {
        const p = P(ar.from[0]), q = P(ar.from[1]);
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        const n = better(mid, unit(-(q.y - p.y), q.x - p.x), 12);
        a = { x: mid.x + n.x * 4, y: mid.y + n.y * 4 };
      } else {
        // Lone pair: leave the atom on the side facing the target, away from its own bonds.
        const p = P(ar.from), d = r(ar.from) + 2;
        const tgt = bondTo ? { x: (P(ar.to[0]).x + P(ar.to[1]).x) / 2, y: (P(ar.to[0]).y + P(ar.to[1]).y) / 2 } : P(ar.to);
        const toward = unit(tgt.x - p.x, tgt.y - p.y);
        let dir;
        if (neighbors(graph, ar.from).length) { const o = outward(ar.from); dir = unit(o.x + 0.9 * toward.x, o.y + 0.9 * toward.y); }
        else {
          const rot = (u, ang) => ({ x: u.x * Math.cos(ang) - u.y * Math.sin(ang), y: u.x * Math.sin(ang) + u.y * Math.cos(ang) });
          const c1 = rot(toward, 0.95), c2 = rot(toward, -0.95);
          dir = clearance({ x: p.x + c1.x * 20, y: p.y + c1.y * 20 }) >= clearance({ x: p.x + c2.x * 20, y: p.y + c2.y * 20 }) ? c1 : c2;
        }
        a = { x: p.x + dir.x * d, y: p.y + dir.y * d };
      }
      if (bondTo) {
        const p = P(ar.to[0]), q = P(ar.to[1]);
        b = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      } else {
        const t = P(ar.to), u = unit(t.x - a.x, t.y - a.y), d = r(ar.to) + 3;
        b = { x: t.x - u.x * d, y: t.y - u.y * d };
      }
    }
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const bend = Math.max(12, 0.42 * L);
    const n = better(mid, { x: -dy / L, y: dx / L }, bend);
    const c = { x: mid.x + n.x * bend, y: mid.y + n.y * bend };
    const marker = ar.type === "fishhook" ? `fh-${id}` : `ah-${id}`;
    paths += `<path d='M ${a.x.toFixed(1)},${a.y.toFixed(1)} Q ${c.x.toFixed(1)},${c.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}' fill='none' stroke='${color}' stroke-width='1.7' stroke-linecap='round' marker-end='url(#${marker})'/>\n`;
    pts.push(a, b, { x: (a.x + 2 * c.x + b.x) / 4, y: (a.y + 2 * c.y + b.y) / 4 });
  });
  const defs = `<defs><marker id='ah-${id}' viewBox='0 0 10 10' refX='7' refY='5' markerWidth='6' markerHeight='6' markerUnits='userSpaceOnUse' orient='auto'><path d='M0,0 L10,5 L0,10 L3,5 z' fill='${color}'/></marker>` +
    `<marker id='fh-${id}' viewBox='0 0 10 10' refX='7' refY='5' markerWidth='6' markerHeight='6' markerUnits='userSpaceOnUse' orient='auto'><path d='M0,0 L10,5 L3,5 z' fill='${color}'/></marker></defs>\n`;

  // Grow the canvas so arrows never get clipped.
  const m = svg.match(/viewBox='([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)'/);
  let [x0, y0, w, h] = m.slice(1).map(Number);
  let x1 = x0 + w, y1 = y0 + h;
  for (const p of pts) { x0 = Math.min(x0, p.x - 10); y0 = Math.min(y0, p.y - 10); x1 = Math.max(x1, p.x + 10); y1 = Math.max(y1, p.y + 10); }
  svg = svg.replace(m[0], `viewBox='${x0.toFixed(1)} ${y0.toFixed(1)} ${(x1 - x0).toFixed(1)} ${(y1 - y0).toFixed(1)}'`)
    .replace(/width='[\d.]+px' height='[\d.]+px'/, `width='${Math.round(x1 - x0)}px' height='${Math.round(y1 - y0)}px'`);
  return svg.replace(/<\/svg>\s*$/, defs + paths + "</svg>");
}

/** Full mechanism step: depict, validate arrows, draw them in both themes. */
export async function mechanismStep(smiles, arrows, stepNo, atomNumbers) {
  const g = (await canonicalize(smiles)).graph;
  validateArrows(arrows, g, stepNo);
  const d = await depict(smiles, { atomNumbers, arrows });
  return {
    ...d,
    light: drawArrows(d.light, d.atoms, d.graph, arrows, ARROW.light, `s${stepNo}l`),
    dark: drawArrows(d.dark, d.atoms, d.graph, arrows, ARROW.dark, `s${stepNo}d`),
  };
}
