import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// Types de base pour l’analyse Leafee
export type PlantIssueSeverity = "low" | "medium" | "high";

export interface PlantIssue {
  code: string; // ex: "under_watering", "low_light"
  label: string; // ex: "Manque d'eau"
}

export interface PlantAnalysisResult {
  plantName: string;
  confidence: number; // 0-1
  issues: PlantIssue[];
  severity: PlantIssueSeverity;
  shortSummary: string;
}

// Schéma d’entrée pour le tool analyze_plant (V2 avec image optionnelle)
const analyzePlantInputSchema = z.object({
  description: z
    .string()
    .min(5)
    .describe(
      "Description de la plante et des symptômes observés (taille, couleur des feuilles, taches, etc.)."
    ),
  room: z
    .string()
    .optional()
    .describe("Pièce ou emplacement de la plante (salon, salle de bain, extérieur...)."),
  wateringFrequency: z
    .string()
    .optional()
    .describe(
      "Fréquence d'arrosage typique (par ex. '1 fois par semaine', 'tous les 3 jours')."
    ),
  imageUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "URL de l'image de la plante à analyser (utilisée pour l'identification via PlantNet)."
    ),
  organ: z
    .string()
    .optional()
    .describe(
      "Organe principal visible sur la photo (par ex. 'leaf', 'flower', 'fruit')."
    ),
});

async function main() {
  const server = new McpServer({
    name: "leafee-mcp",
    version: "1.0.0",
  });

  // Resource UI pour le widget Leafee (text/html+skybridge)
  server.registerResource(
    "leafee-plant-widget",
    "ui://widget/leafee-plant-analyzer.html",
    {},
    async () => ({
      contents: [
        {
          uri: "ui://widget/leafee-plant-analyzer.html",
          mimeType: "text/html+skybridge",
          text: `
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <title>Leafee Plant Analyzer</title>
    <style>
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f5f7fb;
        color: #0f172a;
      }
      .leafee-root {
        padding: 16px;
      }
      .leafee-card {
        background: #ffffff;
        border-radius: 16px;
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08);
        padding: 16px 20px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .leafee-header {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .leafee-avatar {
        width: 32px;
        height: 32px;
        border-radius: 999px;
        background: linear-gradient(135deg, #22c55e, #16a34a);
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: 700;
        font-size: 18px;
      }
      .leafee-title {
        font-weight: 600;
        font-size: 15px;
      }
      .leafee-subtitle {
        font-size: 12px;
        color: #6b7280;
      }
      .leafee-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 4px;
      }
      .leafee-badge {
        border-radius: 999px;
        padding: 2px 10px;
        font-size: 11px;
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .leafee-badge-confidence {
        background: rgba(34, 197, 94, 0.08);
        color: #15803d;
      }
      .leafee-badge-severity-low {
        background: rgba(34, 197, 94, 0.08);
        color: #15803d;
      }
      .leafee-badge-severity-medium {
        background: rgba(234, 179, 8, 0.08);
        color: #a16207;
      }
      .leafee-badge-severity-high {
        background: rgba(239, 68, 68, 0.08);
        color: #b91c1c;
      }
      .leafee-section-title {
        font-size: 13px;
        font-weight: 600;
        margin-top: 8px;
      }
      .leafee-issues {
        list-style: none;
        padding-left: 0;
        margin: 4px 0 0 0;
      }
      .leafee-issues li {
        font-size: 13px;
        margin-bottom: 4px;
        display: flex;
        gap: 6px;
      }
      .leafee-bullet {
        width: 6px;
        height: 6px;
        margin-top: 6px;
        border-radius: 999px;
        background: #22c55e;
      }
      .leafee-summary {
        font-size: 13px;
        color: #4b5563;
      }
      .leafee-empty {
        font-size: 13px;
        color: #9ca3af;
      }
    </style>
  </head>
  <body>
    <div class="leafee-root">
      <div class="leafee-card" id="leafee-card">
        <div class="leafee-header">
          <div class="leafee-avatar">L</div>
          <div>
            <div class="leafee-title">Leafee · Analyse de votre plante</div>
            <div class="leafee-subtitle" id="leafee-subtitle">
              En attente d'une analyse de plante...
            </div>
            <div class="leafee-badges" id="leafee-badges"></div>
          </div>
        </div>
        <div id="leafee-content"></div>
      </div>
    </div>
    <script type="module">
      const output = (window.openai && window.openai.toolOutput) || {};
      const subtitleEl = document.getElementById("leafee-subtitle");
      const badgesEl = document.getElementById("leafee-badges");
      const contentEl = document.getElementById("leafee-content");

      function render() {
        if (!output || Object.keys(output).length === 0) {
          contentEl.innerHTML =
            '<p class="leafee-empty">Demandez à Leafee d\'analyser une plante pour voir le diagnostic ici.</p>';
          return;
        }

        const plantName = output.plantName;
        const confidence = output.confidence;
        const issues = output.issues;
        const severity = output.severity;
        const shortSummary = output.shortSummary;

        subtitleEl.textContent = plantName
          ? "Analyse de votre " + plantName
          : "Analyse de votre plante";

        badgesEl.innerHTML = "";
        if (typeof confidence === "number") {
          const badge = document.createElement("span");
          badge.className = "leafee-badge leafee-badge-confidence";
          const pct = Math.round(confidence * 100);
          badge.textContent = "Confiance " + pct + "%";
          badgesEl.appendChild(badge);
        }

        if (severity) {
          const badge = document.createElement("span");
          badge.className = "leafee-badge leafee-badge-severity-" + severity;
          const labelMap = {
            low: "Gravité faible",
            medium: "Gravité modérée",
            high: "Gravité élevée",
          };
          badge.textContent = labelMap[severity] || "Gravité";
          badgesEl.appendChild(badge);
        }

        const issuesList = Array.isArray(issues) ? issues : [];

        let html = "";
        if (shortSummary) {
          html +=
            '<p class="leafee-summary">' + String(shortSummary) + "</p>";
        }

        if (issuesList.length > 0) {
          html +=
            '<div class="leafee-section"><div class="leafee-section-title">Problèmes détectés</div><ul class="leafee-issues">';
          for (const issue of issuesList) {
            const label =
              (issue && issue.label) ||
              (issue && issue.code) ||
              "Problème";
            html +=
              '<li><span class="leafee-bullet"></span><span>' +
              String(label) +
              "</span></li>";
          }
          html += "</ul></div>";
        }

        if (!html) {
          html =
            '<p class="leafee-empty">Aucun problème majeur détecté pour cette plante.</p>';
        }

        contentEl.innerHTML = html;
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

  // Tool principal: analyze_plant
  server.registerTool(
    "analyze_plant",
    {
      title: "Analyser une plante Leafee",
      description:
        "Analyse une plante à partir d'une description textuelle et retourne un diagnostic structuré.",
      inputSchema: analyzePlantInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/leafee-plant-analyzer.html",
        "openai/toolInvocation/invoking": "Leafee analyse votre plante...",
        "openai/toolInvocation/invoked": "Leafee a terminé l'analyse de votre plante.",
      },
    },
    async (input) => {
      // Appel au backend Leafee via une Edge Function Supabase dédiée.
      // L'URL doit être fournie via la variable d'environnement
      // PLANT_ANALYSIS_FUNCTION_URL (ex:
      // https://<project-ref>.functions.supabase.co/plant-analysis)
      const fnUrl = process.env.PLANT_ANALYSIS_FUNCTION_URL;

      if (!fnUrl) {
        throw new Error(
          "PLANT_ANALYSIS_FUNCTION_URL n'est pas configurée dans l'environnement."
        );
      }

      let analysis: PlantAnalysisResult;

      try {
        const response = await fetch(fnUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-language": "fr",
          },
          body: JSON.stringify({
            description: input.description,
            room: input.room ?? undefined,
            wateringFrequency: input.wateringFrequency ?? undefined,
            imageUrl: input.imageUrl ?? undefined,
            organ: input.organ ?? undefined,
          }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(
            `Edge Function plant-analysis a retourné ${response.status}: ${text}`
          );
        }

        const json = (await response.json()) as unknown;

        // Validation légère runtime pour se protéger des réponses inattendues
        const candidate = json as Partial<PlantAnalysisResult>;

        analysis = {
          plantName: candidate.plantName ?? "Plante d'intérieur",
          confidence:
            typeof candidate.confidence === "number"
              ? Math.max(0, Math.min(1, candidate.confidence))
              : 0.7,
          issues:
            Array.isArray(candidate.issues) && candidate.issues.length > 0
              ? candidate.issues.map((issue) => ({
                  code:
                    typeof issue?.code === "string"
                      ? issue.code
                      : "unknown_issue",
                  label:
                    typeof issue?.label === "string"
                      ? issue.label
                      : "Problème potentiel",
                }))
              : [],
          severity:
            candidate.severity === "low" ||
            candidate.severity === "medium" ||
            candidate.severity === "high"
              ? candidate.severity
              : "medium",
          shortSummary:
            typeof candidate.shortSummary === "string" &&
            candidate.shortSummary.trim().length > 0
              ? candidate.shortSummary
              : "Votre plante montre quelques signes de stress. Ajustons l'arrosage et la lumière, puis surveillons l'évolution.",
        };
      } catch (error) {
        // En cas d'échec, on renvoie un fallback raisonnable pour ne pas casser l'expérience.
        // eslint-disable-next-line no-console
        console.error("Erreur lors de l'appel à plant-analysis:", error);

        analysis = {
          plantName: "Plante d'intérieur",
          confidence: 0.5,
          issues: [
            {
              code: "analysis_error",
              label:
                "Impossible de récupérer l'analyse détaillée pour le moment. Réessayez plus tard.",
            },
          ],
          severity: "medium",
          shortSummary:
            "Leafee a rencontré un problème pour analyser cette plante. Vous pouvez vérifier l'arrosage, la lumière et l'état des feuilles en attendant.",
        };
      }

      const structuredContent = analysis as unknown as {
        [x: string]: unknown;
      };

      return {
        structuredContent,
        content: [
          {
            type: "text",
            text:
              "Voici l'analyse de votre plante basée sur votre description. Leafee affiche le diagnostic détaillé dans le widget.",
          },
        ],
        _meta: {
          originalDescription: input.description,
        },
      };
    }
  );

  const transport = new StreamableHTTPServerTransport();

  await server.connect(transport);

  const app = express();
  app.use(express.json());

  // Endpoint de vérification de domaine OpenAI
  // Voir instructions : placer le token dans
  // /.well-known/openai-apps-challenge
  app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    res
      .status(200)
      .type("text/plain")
      .send("vEtncRd9ZUFWSxBh7jk87AyvDGWZnfK0S_W9JBiVKxA");
  });

  app.post("/mcp", (req, res) => {
    void transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (req, res) => {
    void transport.handleRequest(req, res);
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Leafee MCP server running on http://localhost:${port}/mcp`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Leafee MCP server failed to start", err);
  process.exit(1);
});
