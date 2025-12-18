// supabase/functions/plant-analysis/index.ts
// Analyse de plante pour le serveur MCP Leafee
// Entrée: description textuelle + contexte
// Sortie: structure compatible avec PlantAnalysisResult côté MCP

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

interface PlantIssue {
  code: string;
  label: string;
}

interface PlantAnalysisResult {
  plantName: string;
  confidence: number; // 0-1
  issues: PlantIssue[];
  severity: "low" | "medium" | "high";
  shortSummary: string;
}

interface AnalyzePlantInput {
  description: string;
  room?: string | null;
  wateringFrequency?: string | null;
  imageUrl?: string | null;
  organ?: string | null;
}

async function identifyWithPlantNet(
  imageUrl: string,
  organ: string = "leaf",
): Promise<string | null> {
  const apiKey = Deno.env.get("PlantNet");
  if (!apiKey) {
    console.warn("⚠️ Clé PlantNet manquante (PlantNet)");
    return null;
  }

  try {
    console.log("🌿 Téléchargement de l'image pour PlantNet:", imageUrl);
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      console.error(
        "❌ Erreur téléchargement image:",
        imgRes.status,
        imgRes.statusText,
      );
      return null;
    }

    const arrayBuffer = await imgRes.arrayBuffer();
    const contentType =
      imgRes.headers.get("content-type") ?? "image/jpeg";
    const blob = new Blob([arrayBuffer], { type: contentType });

    const formData = new FormData();
    formData.append("images", blob, "image.jpg");
    formData.append("organs", organ || "leaf");

    const project = "all";
    const url =
      `https://my-api.plantnet.org/v2/identify/${project}?api-key=${apiKey}`;

    console.log("🌿 Appel PlantNet API depuis plant-analysis...");
    const plantnetRes = await fetch(url, {
      method: "POST",
      body: formData,
    });

    if (!plantnetRes.ok) {
      console.error(
        "❌ Erreur PlantNet:",
        plantnetRes.status,
        plantnetRes.statusText,
      );
      return null;
    }

    const plantnetJson: any = await plantnetRes.json();
    const bestMatch = plantnetJson?.bestMatch;
    const bestResult = plantnetJson?.results?.[0];
    const score = typeof bestResult?.score === "number"
      ? bestResult.score
      : null;

    if (!bestMatch) {
      console.warn("⚠️ PlantNet n'a pas renvoyé de bestMatch");
      return null;
    }

    const scorePct = score != null ? ` (~${Math.round(score * 100)}%)` : "";
    const summary = `PlantNet suggère: ${bestMatch}${scorePct}`;
    console.log("✅ Résultat PlantNet:", summary);
    return summary;
  } catch (error) {
    console.error("❌ Erreur lors de l'appel PlantNet:", error);
    return null;
  }
}

async function callGeminiForAnalysis(
  input: AnalyzePlantInput,
  plantnetSummary?: string | null,
): Promise<PlantAnalysisResult> {
  const geminiApiKey = Deno.env.get("GEMINI_API");
  if (!geminiApiKey) {
    console.error("❌ Clé API Gemini manquante (GEMINI_API)");
    throw new Error("Gemini API key not configured");
  }

  const { description, room, wateringFrequency } = input;

  const contextParts: string[] = [
    `Description de la plante et des symptômes: ${description}`,
  ];

  if (room) {
    contextParts.push(`Pièce / emplacement: ${room}`);
  }
  if (wateringFrequency) {
    contextParts.push(`Fréquence d'arrosage: ${wateringFrequency}`);
  }

  if (plantnetSummary) {
    contextParts.push(
      `Résultat PlantNet (basé sur l'image fournie): ${plantnetSummary}`,
    );
  }

  const context = contextParts.join("\n");

  const prompt = `Tu es Leafee, un assistant expert en plantes d'intérieur.

Analyse la situation suivante et réponds STRICTEMENT au format JSON, sans texte avant ou après.

Contexte:
${context}

Réponds avec la structure JSON suivante:
{
  "plantName": "nom supposé de la plante (ou une description générique, ex: 'plante verte d'intérieur')",
  "confidence": nombre entre 0 et 1,
  "issues": [
    { "code": "identifiant_court_en_anglais", "label": "explication courte en français" }
  ],
  "severity": "low" | "medium" | "high",
  "shortSummary": "une phrase ou deux en français pour expliquer la situation et les prochaines actions"
}

Reste concis, utile, et adapte la gravité en fonction de l'urgence perçue pour la plante.`;

  const geminiUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent";

  const response = await fetch(geminiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
    }),
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    console.error("❌ Erreur API Gemini:", response.status, response.statusText, txt);
    throw new Error("Gemini API error");
  }

  const data = await response.json();
  const text: string | undefined =
    data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    console.error("❌ Pas de texte dans la réponse Gemini");
    throw new Error("Empty response from Gemini");
  }

  // Essaye d'extraire un JSON depuis la réponse texte
  let parsed: any;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      parsed = JSON.parse(text);
    }
  } catch (err) {
    console.error("❌ Erreur parsing JSON Gemini:", err);
    throw new Error("Invalid JSON from Gemini");
  }

  // Sécurise / normalise les champs attendus
  const plantName =
    typeof parsed.plantName === "string" && parsed.plantName.trim().length > 0
      ? parsed.plantName.trim()
      : "Plante d'intérieur";

  let confidence = Number(parsed.confidence);
  if (Number.isNaN(confidence)) confidence = 0.7;
  confidence = Math.max(0, Math.min(1, confidence));

  const allowedSeverities = ["low", "medium", "high"] as const;
  let severity: PlantAnalysisResult["severity"] = "medium";
  if (
    typeof parsed.severity === "string" &&
    allowedSeverities.includes(parsed.severity as any)
  ) {
    severity = parsed.severity as PlantAnalysisResult["severity"];
  }

  let issues: PlantIssue[] = [];
  if (Array.isArray(parsed.issues)) {
    issues = parsed.issues
      .map((i: any) => ({
        code: typeof i.code === "string" ? i.code : "unknown",
        label:
          typeof i.label === "string"
            ? i.label
            : typeof i.description === "string"
            ? i.description
            : "Problème potentiel",
      }))
      .filter((i: PlantIssue) => i.label);
  }

  const shortSummary =
    typeof parsed.shortSummary === "string" &&
    parsed.shortSummary.trim().length > 0
      ? parsed.shortSummary.trim()
      : "Votre plante montre quelques signes de stress. Ajustons l'arrosage et la lumière, puis surveillons l'évolution dans les prochains jours.";

  return {
    plantName,
    confidence,
    issues,
    severity,
    shortSummary,
  };
}

serve(async (req) => {
  console.log("🚀 Début de la requête plant-analysis (MCP)");
  console.log("📋 Headers reçus:", Object.fromEntries(req.headers.entries()));

  const allowedOrigin = req.headers.get("origin") || "*";

  if (req.method === "OPTIONS") {
    console.log("✅ Requête OPTIONS - CORS préflight (plant-analysis)");
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type, x-language",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-language",
  } as const;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const body = (await req.json()) as Partial<AnalyzePlantInput>;
    console.log("📥 Body reçu (plant-analysis):", JSON.stringify(body));

    if (!body || typeof body.description !== "string") {
      return new Response("Bad Request: description is required", {
        status: 400,
        headers: corsHeaders,
      });
    }

    const input: AnalyzePlantInput = {
      description: body.description,
      room: body.room ?? null,
      wateringFrequency: body.wateringFrequency ?? null,
      imageUrl: body.imageUrl ?? null,
      organ: body.organ ?? null,
    };
    let plantnetSummary: string | null = null;

    if (input.imageUrl) {
      plantnetSummary = await identifyWithPlantNet(
        input.imageUrl,
        input.organ ?? "leaf",
      );
    }

    const analysis = await callGeminiForAnalysis(input, plantnetSummary);

    return new Response(JSON.stringify(analysis), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  } catch (error) {
    console.error("❌ Erreur dans plant-analysis:", error);
    return new Response("Internal Server Error", {
      status: 500,
      headers: corsHeaders,
    });
  }
});

