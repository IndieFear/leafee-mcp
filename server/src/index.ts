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

// URL de base pour les widgets (doit être accessible par ChatGPT)
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const WIDGET_PATH = "/widget/plant-analyzer";
const WIDGET_URL = `${BASE_URL}${WIDGET_PATH}`;

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
 * HTML DU WIDGET (Inspiré des exemples OpenAI)
 */
const WIDGET_HTML = `
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Leafee Plant Analyzer</title>
    <style>
      :root {
        --primary: #10b981;
        --bg: #ffffff;
        --text: #0f172a;
        --text-muted: #64748b;
        --border: #e2e8f0;
      }
      body { 
        margin: 0; 
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
        background: transparent; 
        color: var(--text);
      }
      .card { 
        background: var(--bg); 
        border: 1px solid var(--border);
        border-radius: 12px; 
        padding: 16px; 
        display: flex; 
        flex-direction: column; 
        gap: 12px;
        max-width: 100%;
        box-sizing: border-box;
      }
      .header { display: flex; justify-content: space-between; align-items: flex-start; }
      .plant-name { font-size: 18px; font-weight: 700; color: #065f46; }
      .badge { 
        border-radius: 999px; 
        padding: 4px 12px; 
        font-size: 12px; 
        font-weight: 600; 
        text-transform: uppercase;
      }
      .severity-low { background: #dcfce7; color: #166534; }
      .severity-medium { background: #fef9c3; color: #854d0e; }
      .severity-high { background: #fee2e2; color: #991b1b; }
      .summary { font-size: 14px; line-height: 1.5; color: var(--text-muted); margin: 0; }
      .issues { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
      .issue-tag { 
        background: #f1f5f9; 
        border: 1px solid var(--border);
        padding: 2px 8px; 
        border-radius: 6px; 
        font-size: 11px; 
        color: #475569;
      }
      .loading { text-align: center; padding: 20px; color: var(--text-muted); font-style: italic; }
    </style>
  </head>
  <body>
    <div id="app">
      <div class="loading">Chargement du diagnostic Leafee...</div>
    </div>

    <script type="module">
      // L'Apps SDK injecte les données dans window.openai
      const getOutput = () => (window.openai && window.openai.toolOutput) || null;
      
      const render = () => {
        const output = getOutput();
        const app = document.getElementById("app");
        
        if (!output) {
          app.innerHTML = '<div class="loading">En attente des données d\\'analyse...</div>';
          return;
        }

        const issuesHtml = (output.issues || [])
          .map(issue => \`<span class="issue-tag">\${issue.label}</span>\`)
          .join('');

        app.innerHTML = \`
          <div class="card">
            <div class="header">
              <div class="plant-name">\${output.plantName || 'Plante analysée'}</div>
              <div class="badge severity-\${output.severity || 'medium'}">
                \${output.severity === 'low' ? 'Saine' : output.severity === 'high' ? 'Urgent' : 'À surveiller'}
              </div>
            </div>
            <p class="summary">\${output.shortSummary || 'Pas de résumé disponible.'}</p>
            \${output.issues && output.issues.length > 0 ? \`
              <div style="font-size: 12px; font-weight: 600; color: #94a3b8; margin-top: 4px;">POINTS D'ATTENTION :</div>
              <div class="issues">\${issuesHtml}</div>
            \` : ''}
          </div>
        \`;
      };

      // Rendu initial
      render();

      // Écouter les changements d'état si nécessaire (pour les interactions)
      if (window.openai && typeof window.openai.onStateChange === 'function') {
        window.openai.onStateChange(() => render());
      }
    </script>
  </body>
</html>
`;

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
    description: "Expert en plantes Leafee. Fournit des diagnostics de santé, des conseils d'entretien et une recherche de connaissances sur les plantes.",
  });

  /**
   * 1. RESSOURCES (MCP COMPLIANCE)
   */
  server.registerResource(
    "leafee-plant-widget",
    WIDGET_URL,
    { title: "Leafee Plant Analysis Widget" },
    async () => ({
      contents: [
        {
          uri: WIDGET_URL,
          mimeType: "text/html",
          text: WIDGET_HTML,
        },
      ],
    })
  );

  /**
   * 2. OUTILS (TOOLS)
   */
  server.registerTool(
    "analyze_plant",
    {
      title: "Analyser une plante Leafee",
      description: "Analyse les symptômes d'une plante (via description ou image) et retourne un diagnostic de santé complet.",
      inputSchema: analyzePlantInputSchema,
      _meta: {
        "openai/outputTemplate": WIDGET_URL,
        "openai/toolInvocation/invoking": "Leafee analyse votre plante...",
        "openai/toolInvocation/invoked": "Analyse terminée.",
        "openai/widgetAccessible": true,
        "openai/resultCanProduceWidget": true
      },
    },
    async (input) => {
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
          shortSummary: json.shortSummary ?? "Analyse terminée avec succès.",
        };
      } catch (error) {
        console.error("[Tool:analyze_plant] Error:", error);
        analysis = {
          plantName: "Plante",
          confidence: 0.5,
          issues: [{ code: "error", label: "Analyse indisponible" }],
          severity: "medium",
          shortSummary: "Une erreur est survenue lors de l'analyse.",
        };
      }

      return {
        structuredContent: analysis as any,
        content: [{ type: "text", text: `Voici l'analyse pour votre ${analysis.plantName}.` }],
        _meta: {
          "openai/outputTemplate": WIDGET_URL,
        },
      };
    }
  );

  // Tool "search"
  server.registerTool(
    "search",
    {
      title: "Search",
      description: "Rechercher dans la base de connaissances Leafee.",
      inputSchema: z.object({
        query: z.string().describe("Termes de recherche.")
      }),
      _meta: { "openai/retrieval": true },
    },
    async ({ query }) => {
      return {
        content: [{ type: "text", text: `Recherche de guides pour "${query}"...` }],
        structuredContent: { results: [] }
      };
    }
  );

  // Tool "fetch"
  server.registerTool(
    "fetch",
    {
      title: "Fetch",
      description: "Récupérer le contenu détaillé.",
      inputSchema: z.object({ id: z.string() }),
      _meta: { "openai/retrieval": true },
    },
    async ({ id }) => {
      return {
        content: [{ type: "text", text: `Détails pour ${id}.` }],
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

  // CORS
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-openai-app-id, x-openai-assistant-id");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // Challenge OpenAI
  app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    res.status(200).type("text/plain").send("vEtncRd9ZUFWSxBh7jk87AyvDGWZnfK0S_W9JBiVKxA");
  });

  // ROUTE POUR LE WIDGET (Crucial pour l'Apps SDK)
  app.get(WIDGET_PATH, (_req, res) => {
    res.status(200).type("text/html").send(WIDGET_HTML);
  });

  // MCP endpoints
  app.post("/mcp", (req, res) => {
    void transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (req, res) => {
    void transport.handleRequest(req, res);
  });

  app.listen(PORT, () => {
    console.log(`Leafee MCP server running on port ${PORT}`);
    console.log(`Widget available at: ${WIDGET_URL}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server", err);
  process.exit(1);
});
