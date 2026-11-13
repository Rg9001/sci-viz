// SciViz: a ChatGPT app (Apps SDK / MCP server) that draws clean skeletal
// structures, reactions and math plots instead of relying on image generation.
import express from "express";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const WIDGET_URI = "ui://widget/sciviz-v1.html";
const widgetHtml = readFileSync(new URL("./widget.html", import.meta.url), "utf8");

const widgetMeta = {
  "openai/outputTemplate": WIDGET_URI,
  "openai/widgetAccessible": false,
  "openai/resultCanProduceWidget": true,
};

function createServer() {
  const server = new McpServer({ name: "sciviz", version: "1.0.0" });

  // The HTML component ChatGPT renders inline.
  server.registerResource("sciviz-widget", WIDGET_URI, {}, async () => ({
    contents: [{
      uri: WIDGET_URI,
      mimeType: "text/html+skybridge",
      text: widgetHtml,
      _meta: {
        "openai/widgetDescription": "Renders skeletal formulas, reactions and math plots.",
        "openai/widgetPrefersBorder": true,
        "openai/widgetCSP": {
          connect_domains: [],
          resource_domains: ["https://cdn.jsdelivr.net"],
        },
      },
    }],
  }));

  // ---- Chemistry: skeletal structures and reactions ----
  server.registerTool("draw_molecules", {
    title: "Draw skeletal structures",
    description:
      "Draw publication-quality 2D skeletal (line-angle) structures from SMILES. Use this " +
      "WHENEVER the user is studying organic chemistry and a structure, mechanism step, " +
      "product, or reaction would help, instead of generating an image. Each entry may be a " +
      "single molecule SMILES or a reaction SMILES 'reactants>reagents>products'. Include " +
      "stereochemistry (@, @@, /, \\) when relevant. Double-check SMILES validity. Only put " +
      "valid SMILES between the '>' signs; put text like 'H2SO4, heat' in 'conditions'.",
    inputSchema: {
      title: z.string().optional().describe("Heading, e.g. 'SN2: bromoethane + hydroxide'"),
      molecules: z.array(z.object({
        smiles: z.string().describe("SMILES or reaction SMILES"),
        name: z.string().optional().describe("Label under the drawing"),
        conditions: z.string().optional()
          .describe("Plain-text reagents/conditions for a reaction, e.g. 'H2SO4, heat'"),
      })).min(1).max(8),
      caption: z.string().optional().describe("One-line explanation under the drawings"),
      explicitHydrogens: z.boolean().optional(),
      terminalCarbons: z.boolean().optional().describe("Label CH3 ends explicitly"),
    },
    _meta: {
      ...widgetMeta,
      "openai/toolInvocation/invoking": "Drawing structures…",
      "openai/toolInvocation/invoked": "Structures drawn",
    },
    annotations: { readOnlyHint: true },
  }, async (args) => ({
    content: [{ type: "text", text: `Drew ${args.molecules.length} structure(s): ` +
      args.molecules.map((m) => m.name || m.smiles).join(", ") }],
    structuredContent: { kind: "molecules", ...args },
  }));

  // ---- Calculus: 2D function plots ----
  server.registerTool("plot_functions", {
    title: "Plot functions",
    description:
      "Plot one or more y = f(x) curves as an interactive graph. Use for calculus and " +
      "algebra: functions, derivatives, tangent lines, limits, asymptotes, and areas under " +
      "curves (set shadeFrom/shadeTo). Expressions use math.js syntax in the variable x, " +
      "e.g. 'sin(x)/x', 'x^3 - 3x', 'e^(-x^2)', 'log(x)' (natural log), 'sqrt(x)'.",
    inputSchema: {
      title: z.string().optional(),
      functions: z.array(z.object({
        expr: z.string().describe("math.js expression in x"),
        label: z.string().optional(),
        dashed: z.boolean().optional().describe("Dashed line, e.g. for tangent lines"),
        shadeFrom: z.number().optional().describe("Shade area under curve from this x"),
        shadeTo: z.number().optional(),
      })).min(1).max(6),
      points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().optional() }))
        .optional().describe("Highlighted points, e.g. critical points"),
      xMin: z.number().optional(), xMax: z.number().optional(),
      yMin: z.number().optional(), yMax: z.number().optional(),
      xLabel: z.string().optional(), yLabel: z.string().optional(),
      caption: z.string().optional(),
    },
    _meta: {
      ...widgetMeta,
      "openai/toolInvocation/invoking": "Plotting…",
      "openai/toolInvocation/invoked": "Plotted",
    },
    annotations: { readOnlyHint: true },
  }, async (args) => ({
    content: [{ type: "text", text: "Plotted: " + args.functions.map((f) => f.expr).join("; ") }],
    structuredContent: { kind: "plot2d", ...args },
  }));

  // ---- Multivariable calc: 3D surfaces ----
  server.registerTool("plot_surface", {
    title: "Plot 3D surface",
    description:
      "Plot an interactive, rotatable 3D surface z = f(x, y) with contour projection. Use " +
      "for multivariable calculus (partial derivatives, saddle points, extrema). math.js syntax.",
    inputSchema: {
      title: z.string().optional(),
      expr: z.string().describe("math.js expression in x and y, e.g. 'x^2 - y^2'"),
      xMin: z.number().optional(), xMax: z.number().optional(),
      yMin: z.number().optional(), yMax: z.number().optional(),
      caption: z.string().optional(),
    },
    _meta: {
      ...widgetMeta,
      "openai/toolInvocation/invoking": "Building surface…",
      "openai/toolInvocation/invoked": "Surface ready",
    },
    annotations: { readOnlyHint: true },
  }, async (args) => ({
    content: [{ type: "text", text: `Plotted surface z = ${args.expr}` }],
    structuredContent: { kind: "plot3d", ...args },
  }));

  return server;
}

// ---- HTTP transport (stateless Streamable HTTP at /mcp) ----
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
