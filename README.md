# SciViz: accurate math, physics and chemistry visuals inside ChatGPT

A ChatGPT app (OpenAI Apps SDK / MCP server). Instead of AI-generated images, every figure
is **computed or verified on the server**:

| Tool | What it does | How it stays accurate |
|---|---|---|
| `draw_molecules` | Skeletal structures with formula and molar mass | RDKit validates every structure; named compounds are checked against **PubChem** (including stereochemistry) and corrected if wrong |
| `draw_reaction` | Reaction schemes with reagents and conditions | Same structure checks, plus an atom and charge balance check |
| `draw_mechanism` | Step-by-step mechanisms with curved electron-pushing arrows | Every arrow must start at a real lone pair or bond (RDKit checks electron counts); atom and charge changes between steps are reported |
| `plot_functions` | Graphs with roots, extrema, inflection points, asymptotes, tangent lines and shaded integrals | All computed by math.js and shown in exact form (π/2, √3, 2/3); discontinuities are broken correctly; points supplied by ChatGPT are checked to lie on the curve |
| `plot_surface` | Rotatable 3D surfaces | Server-sampled |
| `animate_concept` | Riemann sums, secant to tangent, and limits with a slider and play button | Exact integral and derivative values shown |
| `grade_work` | Report card for your work | Math answers are verified by a math engine and orgo structures by RDKit. A verdict that a check **proves** wrong is rejected, and ChatGPT must re-grade before you see it |
| `show_progress` | Scores by topic, weakest topics, streak | Logged automatically by `grade_work` |

**Scope:** the app only activates for math, physics and chemistry. Every tool description
tells ChatGPT not to use it for biology, microbiology, psychology or other subjects, and
`grade_work` hard-rejects any subject outside the allowed list.

See `examples/` for real output.

## Run
```bash
npm install
npm start        # http://localhost:8000/mcp
```
Deploy to Render (build `npm install`, start `npm start`), then add `https://<your-app>.onrender.com/mcp`
in ChatGPT under **Plugins → Add → Add custom MCP server**.

## Make progress history permanent (optional, free)
Render's free tier wipes its disk on restart. Create a free **Redis** database at upstash.com,
then add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` under **Environment** in Render.

## Files
- `server.js`: tool definitions, subject scope, and the checks applied before anything is shown
- `chem.js`: RDKit depiction, PubChem verification, reaction balance, and mechanism arrows and validation
- `mathviz.js`: plotting math (features, asymptotes, tangents, integrals, exact-value formatting)
- `checker.js`: answer verification for grading
- `store.js`: progress storage (Upstash Redis or a local file)
- `widget.html`: the UI shown in ChatGPT (light and dark mode)
