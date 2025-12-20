import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

/**
 * CONSTANTS & CONFIGURATION
 */
const SERVER_NAME = "leafee-mcp";
const SERVER_VERSION = "2.0.1";
const PORT = process.env.PORT || 3000;

// Resolve paths relative to the current file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Base URL for fallback/direct access
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Apps SDK Specific URIs (Must use ui:// schema)
const WIDGET_URI = "ui://widget/plant-analyzer.html";
const WIDGET_PATH = "/widget/plant-analyzer";

// In development (src/index.ts), we are in server/src
// In production (dist/index.js), we are in server/dist
// The web folder is at the root level: ../../web/src
const WEB_SRC_DIR = path.resolve(__dirname, "..", "..", "web", "src");
const CSS_PATH = path.join(WEB_SRC_DIR, "style.css");
const JS_PATH = path.join(WEB_SRC_DIR, "widget.js");

/**
 * TYPES
 */
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
  careTips?: string[];
}

/**
 * WIDGET TEMPLATE GENERATOR
 * Returns the HTML/CSS/JS bundle for the ChatGPT iframe.
 */
function generateWidgetTemplate(): string {
  try {
    const css = readFileSync(CSS_PATH, "utf8");
    const js = readFileSync(JS_PATH, "utf8");

    return `
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Leafee Widget</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module">${js}</script>
  </body>
</html>
    `.trim();
  } catch (error) {
    console.error("[Template] Error reading assets:", error);
    return `<!DOCTYPE html><html><body><div style="color:red;padding:20px;">Widget Error: Missing assets</div></body></html>`;
  }
}

/**
 * MCP SERVER IMPLEMENTATION
 */
async function bootstrap() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: "Expert en soins des plantes Leafee. Fournit des diagnostics et conseils via widgets interactifs.",
  });

  /**
   * 1. REGISTER UI RESOURCE
   * This is the template ChatGPT will load into the iframe.
   */
  server.registerResource(
    "plant-analyzer-widget",
    WIDGET_URI,
    { title: "Leafee Plant Analyzer Widget" },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: "text/html+skybridge",
          text: generateWidgetTemplate(),
          _meta: {
            "openai/widgetPrefersBorder": true,
            "openai/widgetDomain": "https://chatgpt.com",
            "openai/widgetCSP": {
              connect_domains: ["https://chatgpt.com", BASE_URL],
              resource_domains: ["https://*.oaistatic.com"],
            },
            "openai/widgetDescription": "Affiche l'analyse de santé de la plante et des conseils d'entretien interactifs.",
          },
        },
      ],
    })
  );

  /**
   * 2. REGISTER TOOLS
   */
  server.registerTool(
    "analyze_plant",
    {
      title: "Analyser une plante",
      description: "Analyse une plante à partir de sa description ou d'une image.",
      inputSchema: z.object({
        description: z.string().describe("Description des symptômes ou de l'état de la plante."),
        imageUrl: z.string().url().optional().describe("URL de l'image de la plante."),
      }),
      _meta: {
        "openai/outputTemplate": WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/resultCanProduceWidget": true,
        "openai/toolInvocation/invoking": "Leafee prépare le diagnostic...",
        "openai/toolInvocation/invoked": "Diagnostic prêt.",
      },
    },
    async (input) => {
      console.log(`[Tool:analyze_plant] Processing input...`);
      
      const fnUrl = process.env.PLANT_ANALYSIS_FUNCTION_URL;
      if (!fnUrl) throw new Error("Missing PLANT_ANALYSIS_FUNCTION_URL");

      try {
        const response = await fetch(fnUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-language": "fr" },
          body: JSON.stringify(input),
        });

        if (!response.ok) throw new Error(`API Error: ${response.status}`);
        const data = (await response.json()) as Partial<PlantAnalysisResult>;

        const result: PlantAnalysisResult = {
          plantName: data.plantName ?? "Plante inconnue",
          confidence: data.confidence ?? 1.0,
          issues: data.issues ?? [],
          severity: data.severity ?? "medium",
          shortSummary: data.shortSummary ?? "Analyse terminée.",
          careTips: data.careTips ?? ["Vérifiez l'exposition", "Ajustez l'arrosage"],
        };

        return {
          // structuredContent: What the model sees (Keep it concise)
          structuredContent: {
            plant: result.plantName,
            status: result.severity,
            summary: result.shortSummary,
          },
          // content: Optional narration for the chat
          content: [{ type: "text", text: `J'ai terminé l'analyse de votre ${result.plantName}.` }],
          // _meta: Rich data for the widget only
          _meta: {
            ...result,
            "openai/outputTemplate": WIDGET_URI,
          },
        };
      } catch (error) {
        console.error("[Tool:analyze_plant] Error:", error);
        return {
          content: [{ type: "text", text: "Désolé, je n'ai pas pu analyser la plante pour le moment." }],
          structuredContent: { error: "Analysis failed" }
        };
      }
    }
  );

  /**
   * 3. ADDITIONAL TOOLS (Knowledge Base)
   */
  server.registerTool(
    "search_knowledge",
    {
      title: "Rechercher des connaissances",
      description: "Rechercher dans la base de connaissances Leafee pour des guides d'entretien.",
      inputSchema: z.object({
        query: z.string().describe("Termes de recherche."),
      }),
      _meta: { "openai/retrieval": true },
    },
    async ({ query }) => {
      console.log(`[Tool:search_knowledge] Query: ${query}`);
      return {
        content: [{ type: "text", text: `Recherche de guides pour "${query}"...` }],
        structuredContent: { results: [] }
      };
    }
  );

  server.registerTool(
    "get_plant_details",
    {
      title: "Détails de la plante",
      description: "Récupérer des informations détaillées sur une plante spécifique par son ID.",
      inputSchema: z.object({
        id: z.string().describe("L'ID unique de la plante."),
      }),
      _meta: { "openai/retrieval": true },
    },
    async ({ id }) => {
      console.log(`[Tool:get_plant_details] ID: ${id}`);
      return {
        content: [{ type: "text", text: `Récupération des détails pour l'ID ${id}...` }],
      };
    }
  );

  /**
   * 4. TRANSPORT & EXPRESS SERVER
   */
  const transport = new StreamableHTTPServerTransport();
  await server.connect(transport);

  const app = express();
  app.use(express.json());

  // CORS - Required for Apps SDK communication
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-openai-app-id, x-openai-assistant-id");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // Verification endpoint for OpenAI
  app.get("/.well-known/openai-apps-challenge", (_, res) => {
    res.status(200).type("text/plain").send("vEtncRd9ZUFWSxBh7jk87AyvDGWZnfK0S_W9JBiVKxA");
  });

  // Widget Route (Fallback for direct embedding or development)
  app.get(WIDGET_PATH, (_, res) => {
    res.status(200).type("text/html+skybridge").send(generateWidgetTemplate());
  });

  // MCP Standard Endpoints
  app.post("/", (req, res) => transport.handleRequest(req, res, req.body));
  app.get("/", (req, res) => transport.handleRequest(req, res));

  app.listen(PORT, () => {
    console.log(`\n🚀 Leafee MCP Server v${SERVER_VERSION}`);
    console.log(`- MCP Endpoint: ${BASE_URL}/`);
    console.log(`- Widget URI: ${WIDGET_URI}`);
    console.log(`- Widget Fallback: ${BASE_URL}${WIDGET_PATH}\n`);
  });
}

bootstrap().catch((err) => {
  console.error("Critical failure during bootstrap:", err);
  process.exit(1);
});
