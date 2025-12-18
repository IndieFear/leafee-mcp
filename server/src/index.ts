import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

/**
 * CONFIGURATION & TYPES
 */
const SERVER_NAME = "leafee-mcp";
const SERVER_VERSION = "1.1.0";
const PORT = process.env.PORT || 3000;
const WIDGET_URI = "ui://widget/leafee-plant-analyzer.html";

export type PlantIssueSeverity = "low" | "medium" | "high";

export interface PlantIssue {
  code: string;
  label: string;
}

export interface PlantAnalysisResult {
  plantName: string;
  confidence: number;
  issues: PlantIssue[];
  severity: PlantIssueSeverity;
  shortSummary: string;
}

/**
 * SCHÉMAS DE VALIDATION (ZOD)
 */
const analyzePlantInputSchema = z.object({
  description: z
    .string()
    .min(5)
    .describe("Description de la plante et des symptômes observés."),
  room: z
    .string()
    .optional()
    .describe("Pièce ou emplacement de la plante."),
  wateringFrequency: z
    .string()
    .optional()
    .describe("Fréquence d'arrosage typique."),
  imageUrl: z
    .string()
    .url()
    .optional()
    .describe("URL de l'image de la plante à analyser."),
  organ: z
    .string()
    .optional()
    .describe("Organe principal visible sur la photo."),
});

async function main() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  /**
   * 1. RESSOURCES (WIDGETS UI)
   */
  server.registerResource(
    "leafee-plant-widget",
    WIDGET_URI,
    {},
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: "text/html+skybridge",
          text: `
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <title>Leafee Plant Analyzer</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #f5f7fb; color: #0f172a; }
      .leafee-root { padding: 16px; }
      .leafee-card { background: #ffffff; border-radius: 16px; box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08); padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
      .badge { border-radius: 999px; padding: 2px 10px; font-size: 11px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; }
      .severity-low { background: rgba(34, 197, 94, 0.08); color: #15803d; }
      .severity-medium { background: rgba(234, 179, 8, 0.08); color: #a16207; }
      .severity-high { background: rgba(239, 68, 68, 0.08); color: #b91c1c; }
    </style>
  </head>
  <body>
    <div class="leafee-root">
      <div class="leafee-card" id="leafee-card">
        <div id="leafee-content">Chargement du diagnostic...</div>
      </div>
    </div>
    <script type="module">
      const output = (window.openai && window.openai.toolOutput) || {};
      const contentEl = document.getElementById("leafee-content");

      function render() {
        if (!output || Object.keys(output).length === 0) {
          contentEl.innerHTML = '<p>Demandez à Leafee d\'analyser une plante.</p>';
          return;
        }
        contentEl.innerHTML = \`
          <div style="font-weight: 600;">\${output.plantName || "Plante"}</div>
          <div class="badge severity-\${output.severity || 'medium'}">\${output.severity || 'Analyse'}</div>
          <p style="font-size: 13px; color: #4b5563;">\${output.shortSummary || ""}</p>
        \`;
      }
      render();
    </script>
  </body>
</html>
          `.trim(),
          _meta: {
            "openai/widgetPrefersBorder": true,
          },
        },
      ],
    })
  );

  /**
   * 2. OUTILS (TOOLS)
   */

  // Tool principal: analyze_plant
  server.registerTool(
    "analyze_plant",
    {
      title: "Analyser une plante Leafee",
      description: "Analyse une plante à partir d'une description et retourne un diagnostic.",
      inputSchema: analyzePlantInputSchema,
      _meta: {
        "openai/outputTemplate": WIDGET_URI,
        "openai/toolInvocation/invoking": "Leafee analyse votre plante...",
        "openai/toolInvocation/invoked": "Analyse terminée.",
        "openai/widgetAccessible": true,
        "openai/resultCanProduceWidget": true
      },
    },
    async (input) => {
      // eslint-disable-next-line no-console
      console.log(`[Tool:analyze_plant] Input: ${JSON.stringify(input)}`);
      
      const fnUrl = process.env.PLANT_ANALYSIS_FUNCTION_URL;
      if (!fnUrl) {
        throw new Error("PLANT_ANALYSIS_FUNCTION_URL non configurée.");
      }

      let analysis: PlantAnalysisResult;

      try {
        const response = await fetch(fnUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-language": "fr" },
          body: JSON.stringify(input),
        });

        if (!response.ok) {
          throw new Error(`Erreur API: ${response.status}`);
        }

        const json = (await response.json()) as Partial<PlantAnalysisResult>;
        analysis = {
          plantName: json.plantName ?? "Plante d'intérieur",
          confidence: json.confidence ?? 0.7,
          issues: Array.isArray(json.issues) ? json.issues : [],
          severity: json.severity ?? "medium",
          shortSummary: json.shortSummary ?? "Analyse en cours...",
        };
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[Tool:analyze_plant] Error:", error);
        analysis = {
          plantName: "Plante",
          confidence: 0.5,
          issues: [{ code: "error", label: "Analyse impossible" }],
          severity: "medium",
          shortSummary: "Une erreur est survenue lors de l'analyse.",
        };
      }

      return {
        structuredContent: analysis as any,
        content: [{ type: "text", text: "Diagnostic disponible dans le widget Leafee." }],
        _meta: {
          "openai/outputTemplate": WIDGET_URI,
          "openai/widgetAccessible": true,
          "openai/resultCanProduceWidget": true
        },
      };
    }
  );

  // Tool "search" (Retrieval)
  server.registerTool(
    "search",
    {
      title: "Search",
      description: "Rechercher des informations sur les plantes et l'entretien.",
      inputSchema: z.object({
        query: z.string().describe("La requête de recherche (ex: 'entretien Monstera', 'tâches brunes feuilles').")
      }),
      _meta: { "openai/retrieval": true },
    },
    async ({ query }) => {
      // eslint-disable-next-line no-console
      console.log(`[Tool:search] Query: ${query}`);
      return {
        content: [{ type: "text", text: `Recherche Leafee pour: ${query}` }],
      };
    }
  );

  // Tool "fetch" (Retrieval - Requis par OpenAI)
  server.registerTool(
    "fetch",
    {
      title: "Fetch",
      description: "Récupérer le contenu d'une ressource via son identifiant.",
      inputSchema: z.object({ id: z.string().describe("L'identifiant de la ressource à récupérer.") }),
      _meta: { "openai/retrieval": true },
    },
    async ({ id }) => {
      // eslint-disable-next-line no-console
      console.log(`[Tool:fetch] ID: ${id}`);
      return {
        content: [{ type: "text", text: `Contenu de la ressource: ${id}` }],
      };
    }
  );

  /**
   * 3. TRANSPORT & EXPRESS
   */
  const transport = new StreamableHTTPServerTransport();
  await server.connect(transport);

  const app = express();
  app.use(express.json());

  // Middleware CORS complet pour l'Apps SDK
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    res.status(200).type("text/plain").send("vEtncRd9ZUFWSxBh7jk87AyvDGWZnfK0S_W9JBiVKxA");
  });

  app.post("/mcp", (req, res) => {
    // eslint-disable-next-line no-console
    console.log(`[MCP] POST Request`);
    void transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (req, res) => {
    // eslint-disable-next-line no-console
    console.log(`[MCP] GET Request`);
    void transport.handleRequest(req, res);
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Leafee MCP server running on port ${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server", err);
  process.exit(1);
});
