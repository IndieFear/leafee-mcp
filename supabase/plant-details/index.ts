// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

// Fonction pour récupérer les images Wikipedia d'une plante
async function getWikipediaPlantImages(scientificName: string, limit: number = 5): Promise<string[]> {
  const urls = new Set<string>(); // Pour éviter les doublons

  try {
    console.log(`🖼️ Récupération des images Wikipedia pour: ${scientificName}`);

    // 1️⃣ Récupérer l'image principale de la page (pageimages)
    const mainImageRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(
        scientificName
      )}&prop=pageimages&format=json&pithumbsize=500&origin=*`
    );
    const mainData = await mainImageRes.json();
    const mainPages = Object.values(mainData.query.pages);
    if (mainPages[0]?.thumbnail?.source) {
      urls.add(mainPages[0].thumbnail.source);
      console.log('✅ Image principale trouvée');
    }

    // 2️⃣ Récupérer toutes les images listées sur la page (prop=images)
    const imagesRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(
        scientificName
      )}&prop=images&format=json&origin=*`
    );
    const imagesData = await imagesRes.json();
    const pages = Object.values(imagesData.query.pages);
    const images = pages[0]?.images || [];

    // Filtrer les formats valides et récupérer les URLs directes
    for (let img of images) {
      if (/\.(jpg|jpeg|png)$/i.test(img.title)) {
        const fileRes = await fetch(
          `https://en.wikipedia.org/w/api.php?action=query&titles=File:${encodeURIComponent(
            img.title.replace("File:", "")
          )}&prop=imageinfo&iiprop=url&format=json&origin=*`
        );
        const fileData = await fileRes.json();
        const page = Object.values(fileData.query.pages)[0];
        const url = page?.imageinfo?.[0]?.url;
        if (url) {
          urls.add(url);
          if (urls.size >= limit) break;
        }
      }
    }

    // 3️⃣ Récupérer images via Wikidata P18 si on a moins que 'limit'
    if (urls.size < limit) {
      const searchQidRes = await fetch(
        `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
          scientificName
        )}&language=en&format=json&origin=*`
      );
      const qidData = await searchQidRes.json();
      if (qidData.search?.length) {
        const qid = qidData.search[0].id;
        const entityRes = await fetch(
          `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`
        );
        const entityData = await entityRes.json();
        const claims = entityData.entities[qid]?.claims;
        const imageName = claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        if (imageName) {
          urls.add(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageName)}`);
        }
      }
    }

    const result = Array.from(urls).slice(0, limit);
    console.log(`✅ ${result.length} images trouvées pour ${scientificName}`);
    return result;

  } catch (error) {
    console.error(`❌ Erreur lors de la récupération des images Wikipedia pour ${scientificName}:`, error);
    return [];
  }
}

// Fonction pour récupérer les images depuis l'API Trefle (prioritaire)
async function getTreflePlantImages(scientificName: string, perCategoryLimit: number = 2): Promise<string[]> {
  const token = Deno.env.get('TREFLE_API_TOKEN');
  if (!token) {
    console.warn('⚠️ TREFLE_API_TOKEN non configuré');
    return [];
  }

  try {
    console.log(`🌿 Recherche Trefle pour: ${scientificName}`);
    const searchUrl = `https://trefle.io/api/v1/plants/search?token=${token}&q=${encodeURIComponent(scientificName)}`;
    const searchRes = await fetch(searchUrl);

    if (!searchRes.ok) {
      console.error('❌ Erreur API Trefle (search):', searchRes.status, searchRes.statusText);
      return [];
    }

    const searchData = await searchRes.json();
    const searchResults = searchData?.data;
    if (!Array.isArray(searchResults) || searchResults.length === 0) {
      console.warn('⚠️ Aucun résultat de recherche Trefle pour:', scientificName);
      return [];
    }

    const firstResult = searchResults[0];
    const plantId = firstResult?.id || firstResult?.main_species_id;

    if (!plantId) {
      console.warn('⚠️ Aucune plante trouvée sur Trefle pour:', scientificName);
      return [];
    }

    const detailUrl = `https://trefle.io/api/v1/plants/${plantId}?token=${token}`;
    const detailRes = await fetch(detailUrl);

    if (!detailRes.ok) {
      console.error('❌ Erreur API Trefle (detail):', detailRes.status, detailRes.statusText);
      return [];
    }

    const detailData = await detailRes.json();
    const dataNode = detailData?.data;
    const images =
      dataNode?.images ||
      dataNode?.main_species?.images ||
      dataNode?.main_species?.main_species?.images; // fallback si structure imbriquée

    if (!images) {
      console.warn('⚠️ Pas d’images disponibles sur Trefle pour:', scientificName);
      return [];
    }

    const categories: Array<'leaf' | 'habit' | 'flower'> = ['leaf', 'habit', 'flower'];
    const collected: string[] = [];
    const seen = new Set<string>();
    const maxTotal = perCategoryLimit * categories.length;

    for (const category of categories) {
      const categoryImages = images[category] || [];
      let count = 0;

      for (const image of categoryImages) {
        const url = image?.image_url;
        if (url && !seen.has(url)) {
          seen.add(url);
          collected.push(url);
          count += 1;
        }

        if (count >= perCategoryLimit || collected.length >= maxTotal) {
          break;
        }
      }

      if (collected.length >= maxTotal) {
        break;
      }
    }

    console.log(`✅ ${collected.length} images récupérées depuis Trefle pour ${scientificName}`);
    return collected;
  } catch (error) {
    console.error(`❌ Erreur lors de la récupération des images Trefle pour ${scientificName}:`, error);
    return [];
  }
}

serve(async (req) => {
  console.log('🚀 Début de la requête plant-details');
  console.log('📋 Headers reçus:', Object.fromEntries(req.headers.entries()));
  
  // CORS: autorise toutes les origines (pour dev, à restreindre en prod)
  const allowedOrigin = req.headers.get('origin') || '*';
  
  // Répondre aux requêtes OPTIONS (preflight)
  if (req.method === 'OPTIONS') {
    console.log('✅ Requête OPTIONS - CORS préflight');
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-language',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  // Ajoute les headers CORS à toutes les réponses
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-language'
  };

  // Auth Supabase optionnelle
  const authHeader = req.headers.get('Authorization') || '';
  console.log('🔐 Header Authorization:', authHeader ? 'Présent' : 'Absent');
  // Initialisation du client Supabase (sans obligation d'Authorization)
  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    authHeader.startsWith('Bearer ')
      ? { global: { headers: { Authorization: authHeader } } }
      : undefined
  );

  // Client avec SERVICE_ROLE pour l'insertion
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  try {
    // Récupère le nom scientifique depuis le body
    const body = await req.json();
    console.log('📥 Body reçu:', JSON.stringify(body));
    
    const { scientificName } = body;
    
    if (!scientificName) {
      console.error('❌ scientificName manquant dans le body');
      return new Response('Bad Request: scientificName is required', { 
        status: 400,
        headers: corsHeaders
      });
    }

    // Récupère la langue depuis les headers (défaut: français)
    const language = req.headers.get('x-language') || req.headers.get('accept-language')?.split(',')[0]?.split('-')[0] || 'fr';
    const isEnglish = language === 'en';
    
    console.log('🔍 Recherche pour:', scientificName, 'en', language);

    // 1. Cherche d'abord dans la base de données (cache) selon la langue
    const resultColumn = isEnglish ? 'result_en' : 'result_fr';
    const { data: existingDetails, error: selectError } = await supabaseAdmin
      .from('plant_details')
      .select(`scientific_name, ${resultColumn}, images`)
      .eq('scientific_name', scientificName)
      .maybeSingle();

    if (selectError && selectError.code !== 'PGRST116') {
      console.error('❌ Erreur lors de la recherche en cache:', selectError);
    }

    if (existingDetails && existingDetails[resultColumn]) {
      console.log('✅ Détails trouvés en cache pour:', scientificName, 'en', language);
      
      // Retourne les détails avec les images si disponibles
      const responseData = {
        ...existingDetails[resultColumn],
        images: existingDetails.images || []
      };
      
      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    // 2. Si pas en cache, appelle Gemini dans les deux langues ET récupère les images
    console.log('🔄 Appel Gemini et récupération d\'images pour:', scientificName, 'en', language);
    const geminiApiKey = Deno.env.get('GEMINI_API');
    if (!geminiApiKey) {
      console.error('❌ Clé API Gemini manquante');
      return new Response('Server Error: Gemini API key not configured', { 
        status: 500,
        headers: corsHeaders
      });
    }

    // Fonction pour appeler Gemini dans une langue spécifique
    async function callGeminiInLanguage(lang: string) {
      const isLangEnglish = lang === 'en';
      const prompt = isLangEnglish ? 
        `You are a botanical expert. Give me detailed and useful information about the plant "${scientificName}" in English.

Answer in JSON format with the following fields:
{
  "common_name": "the most common name in English, only one name, no bracket, if no common name, return the scientific name",
  "scientific_name": "scientific name",
  "easy": "1 to 3",
  "exposure": "detailed exposure information",
  "exposure_tag": "ULTRA SHORT exposure tag (1-2 words max like 'Full sun', 'Partial shade', 'Indirect light')",
  "water": "watering advice",
  "family": "botanical family",
  "description": "detailed plant description",
  "watering": "watering tips",
  "care": "care tips",
  "growth": "growth type and size",
  "flowering": "flowering period if applicable",
  "resistance": "cold, drought resistance, etc.",
  "temperature": "recommended temperature",
  "multiplication": "multiplication methods",
  "diseases": "possible diseases and what to watch out for",
  "advice": ["practical tips for gardeners, max 5 tips"],
  "interest": "ornamental or utility interest",
  "toxicity": "plant toxicity description",
  "origin": "plant origin (continent), no brackets, just the continent name"
}

Be precise, concise, practical and useful for amateur gardeners. Use the common name to talk about the plant in general.` :

        `Tu es un expert botaniste. Donne-moi des informations détaillées et utiles sur la plante "${scientificName}" en français. 

Réponds au format JSON avec les champs suivants (utilise les clés en anglais) :
{
  "common_name": "le nom commun en français le plus connu, un seul nom, pas de parenthèse, si pas de nom commun, retourne le nom scientifique",
  "scientific_name": "nom scientifique",
  "easy": "de 1 à 3",
  "exposure": "informations détaillées sur l'exposition",
  "exposure_tag": "TAG ULTRA COURT d'exposition (1-2 mots max comme 'Plein soleil', 'Mi-ombre', 'Lumière indirecte')",
  "water": "conseil sur l'arrosage",
  "family": "famille botanique",
  "description": "description détaillée de la plante",
  "watering": "conseils d'arrosage",
  "care": "conseils d'entretien",
  "growth": "type de croissance et taille",
  "flowering": "période de floraison si applicable",
  "resistance": "résistance au froid, sécheresse, etc.",
  "temperature": "temperature recommandée",
  "multiplication": "méthodes de multiplication",
  "diseases": "maladies possibles et à quoi faire attention",
  "advice": ["conseils pratiques pour les jardiniers, 5 conseils maximum"],
  "interest": "intérêt ornemental ou utilitaire",
  "toxicity": "description de la toxicité de la plante",
  "origin": "origine de la plante (continent), pas de parenthèse, juste le nom du continent"
}

Sois précis, concis, pratique et utile pour un jardinier amateur. Utilise le nom commun pour parler de la plante en général.`;

      console.log(`🌍 Appel Gemini en ${lang} pour:`, scientificName);
      
      // Utilise un modèle stable pour éviter les 404 (les previews expirent vite)
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent`;
      
      const geminiResponse = await fetch(geminiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiApiKey
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }]
        })
      });

      if (!geminiResponse.ok) {
        const errorText = await geminiResponse.text().catch(() => '');
        console.error(`❌ Erreur API Gemini (${lang}):`, geminiResponse.status, geminiResponse.statusText, errorText);
        return null;
      }

      const geminiData = await geminiResponse.json();
      console.log(`📋 Réponse Gemini reçue (${lang})`);
      
      // Extrait le texte de la réponse Gemini
      const geminiText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!geminiText) {
        console.error(`❌ Pas de texte dans la réponse Gemini (${lang})`);
        return null;
      }

      // Tente de parser le JSON de la réponse
      let parsedDetails;
      try {
        // Nettoie le texte pour extraire le JSON
        const jsonMatch = geminiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedDetails = JSON.parse(jsonMatch[0]);
        } else {
          parsedDetails = {};
        }
      } catch (parseError) {
        console.error(`❌ Erreur parsing JSON Gemini (${lang}):`, parseError);
        parsedDetails = {};
      }

      // Liste des champs attendus
      const expectedFields = [
        'common_name', 'scientific_name', 'easy', 'exposure', 'exposure_tag', 'water', 'family', 'description',
        'watering', 'care', 'growth', 'flowering', 'resistance', 'temperature',
        'multiplication', 'diseases', 'advice', 'interest', 'toxicity', 'frequency', 'origin'
      ];

      // Fallbacks robustes pour chaque champ
      const safeDetails = {};
      for (const key of expectedFields) {
        let value = parsedDetails[key];
        // Si le champ est un tableau sous forme de string, tente de parser
        if (typeof value === 'string' && value.trim().startsWith('[') && value.trim().endsWith(']')) {
          try {
            value = JSON.parse(value);
          } catch {}
        }
        // Si le champ est censé être un tableau mais n'est pas, force tableau
        if (key === 'advice' && value && !Array.isArray(value)) {
          value = [value];
        }
        safeDetails[key] = value ?? null;
      }

      return safeDetails;
    }

    // Appelle Gemini dans les deux langues et prépare la récupération d'images
    console.log('🔄 Appel Gemini dans les deux langues et récupération d\'images pour:', scientificName);
    const [frenchDetails, englishDetails, trefleImages] = await Promise.all([
      callGeminiInLanguage('fr'),
      callGeminiInLanguage('en'),
      getTreflePlantImages(scientificName, 2)
    ]);

    let plantImages = trefleImages;
    let imagesSource: 'trefle' | 'wikipedia' | 'none' = 'none';

    if (plantImages && plantImages.length > 0) {
      imagesSource = 'trefle';
    } else {
      plantImages = await getWikipediaPlantImages(scientificName, 5);
      imagesSource = plantImages.length > 0 ? 'wikipedia' : 'none';
    }

    // Prépare les données à insérer
    const insertData: any = {
      scientific_name: scientificName
    };

    if (frenchDetails) {
      insertData.result_fr = frenchDetails;
      console.log('✅ Détails français obtenus');
    }

    if (englishDetails) {
      insertData.result_en = englishDetails;
      console.log('✅ Détails anglais obtenus');
    }

    if (plantImages && plantImages.length > 0) {
      insertData.images = plantImages;
      console.log(`✅ ${plantImages.length} images stockées (source: ${imagesSource})`);
    }

    // Vérifie qu'au moins une langue a été obtenue (contrainte check_at_least_one_language)
    if (!frenchDetails && !englishDetails) {
      console.error('❌ Aucune langue n\'a pu être obtenue depuis Gemini - annulation de l\'insertion');
      return new Response('Service Unavailable: Unable to generate plant details', {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    console.log('💾 Données à insérer:', JSON.stringify(insertData, null, 2));

    // Vérifie si l'enregistrement existe déjà
    const { data: existingRecord } = await supabaseAdmin
      .from('plant_details')
      .select('id')
      .eq('scientific_name', scientificName)
      .maybeSingle();

    let insertResult;
    if (existingRecord) {
      // Met à jour l'enregistrement existant
      const { data: updateResult, error: updateError } = await supabaseAdmin
        .from('plant_details')
        .update(insertData)
        .eq('scientific_name', scientificName)
        .select();
      
      if (updateError) {
        console.error('❌ Erreur mise à jour plant_details:', updateError);
      } else {
        console.log('✅ Détails mis à jour en cache pour:', scientificName, 'dans les deux langues avec images');
        insertResult = updateResult;
      }
    } else {
      // Insère un nouvel enregistrement
      const { data: insertDataResult, error: insertError } = await supabaseAdmin
        .from('plant_details')
        .insert(insertData)
        .select();
      
      if (insertError) {
        console.error('❌ Erreur insertion plant_details:', insertError);
      } else {
        console.log('✅ Détails stockés en cache pour:', scientificName, 'dans les deux langues avec images');
        insertResult = insertDataResult;
      }
    }

    // Retourne les détails dans la langue demandée avec les images
    const requestedDetails = isEnglish ? englishDetails : frenchDetails;
    const responseData = {
      ...requestedDetails,
      images: plantImages || []
    };
    
    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });

  } catch (error) {
    console.error('❌ Error in plant-details function:', error);
    console.error('❌ Stack trace:', error.stack);
    return new Response('Internal Server Error', { 
      status: 500,
      headers: corsHeaders
    });
  }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/plant-details' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --header 'X-Language: fr' \
    --data '{"scientificName":"Rosa"}'

*/
