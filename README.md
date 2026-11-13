# SciViz: clean chemistry and calculus visuals inside ChatGPT

A ChatGPT **App** (built on OpenAI's Apps SDK, which uses an MCP server). When you study
orgo or calc, ChatGPT calls these tools. You get real rendered drawings instead of
AI-generated images:

| Tool | What it draws | Powered by |
|---|---|---|
| `draw_molecules` | Skeletal (line-angle) structures and full reactions from SMILES, with stereo wedges | SmilesDrawer |
| `plot_functions` | Interactive y = f(x) graphs: tangents, shaded integrals, labeled critical points | math.js and Plotly |
| `plot_surface` | Rotatable 3D surfaces z = f(x, y) with contour projections | Plotly |

See `examples/` for sample output.

## 1. Run the server

```bash
npm install
npm start        # serves http://localhost:8000/mcp
```

## 2. Give it a public HTTPS URL

ChatGPT has to reach your server over the internet. For a quick setup, use a tunnel:

```bash
ngrok http 8000      # or: cloudflared tunnel --url http://localhost:8000
```

Copy the `https://…` URL and add `/mcp` to the end.

To keep it always on, deploy this folder to Render, Railway, or Fly.io.
They all run `npm start` as-is.

## 3. Connect it to ChatGPT

1. In ChatGPT, open **Settings → Apps & Connectors → Advanced settings** and turn on **Developer mode**.
2. Go back to **Apps & Connectors** and click **Create**. Name it "SciViz", paste
   `https://<your-url>/mcp`, and choose **No authentication**.
3. In a new chat, enable SciViz from the **+ / Tools** menu, then ask something like:
   - "Show the mechanism products of the E2 of 2-bromobutane with tBuOK"
   - "Graph sin(x)/x from -20 to 20 and shade the area from 0 to π"
   - "Plot z = x² − y² and explain why the origin is a saddle point"

Tip: add a line to your ChatGPT custom instructions, e.g. "When studying chemistry or math,
always use SciViz to draw structures and graphs instead of generating images."

OpenAI renames these menus from time to time. If the steps don't match what you see,
search their docs for "Apps SDK connect from ChatGPT".

## Files
- `server.js`: the MCP server. Defines the tools and the descriptions ChatGPT reads to decide when to use them.
- `widget.html`: the UI rendered inline in the chat. Supports light and dark mode.
