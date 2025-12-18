// supabase/functions/plant-identification/index.ts
// Fonction d'identification de plantes via PlantNet API
// Supporte les utilisateurs connectés et anonymes
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
// Fonction pour uploader l'image vers Supabase Storage
async function uploadImageToStorage(base64Image, userId, supabaseAdmin) {
  try {
    console.log('📤 Upload de l\'image compressée vers Supabase Storage...');
    // Convertit le base64 en blob
    const base64Data = base64Image;
    const byteCharacters = atob(base64Data);
    const byteNumbers = new Array(byteCharacters.length);
    for(let i = 0; i < byteCharacters.length; i++){
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([
      byteArray
    ], {
      type: 'image/jpeg'
    });
    // Crée un nom de fichier unique
    const timestamp = Date.now();
    const uniqueFileName = `${userId}/${timestamp}_plant.jpg`;
    // Upload vers Supabase Storage
    const { data, error } = await supabaseAdmin.storage.from('plant-images').upload(uniqueFileName, blob, {
      contentType: 'image/jpeg',
      cacheControl: '3600'
    });
    if (error) {
      console.error('❌ Erreur upload Storage:', error);
      throw new Error('Impossible d\'uploader l\'image');
    }
    // Récupère l'URL publique
    const { data: urlData } = supabaseAdmin.storage.from('plant-images').getPublicUrl(uniqueFileName);
    console.log(`✅ Image uploadée: ~${Math.round(byteArray.length / 1024)}KB`);
    return urlData.publicUrl;
  } catch (error) {
    console.error('❌ Erreur upload image:', error);
    throw new Error('Impossible de sauvegarder l\'image');
  }
}
serve(async (req)=>{
  console.log('🚀 Début de la requête plant-identification');
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
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-language, x-anonymous-id',
        'Access-Control-Max-Age': '86400'
      }
    });
  }
  // Ajoute les headers CORS à toutes les réponses
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-language, x-anonymous-id'
  };
  // Auth Supabase optionnelle
  const authHeader = req.headers.get('Authorization') || '';
  console.log('🔐 Header Authorization:', authHeader ? 'Présent' : 'Absent');
  // Initialisation du client Supabase (sans obligation d'Authorization)
  const supabaseClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', authHeader.startsWith('Bearer ') ? {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  } : undefined);
  // Récupère l'utilisateur si un token est fourni, sinon anonyme
  let user = null;
  if (authHeader.startsWith('Bearer ')) {
    console.log('🔓 Tentative d\'authentification avec token');
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (!userError) {
      user = userData.user ?? null;
      console.log('✅ Utilisateur authentifié:', user?.email || user?.id);
    } else {
      console.log('❌ Erreur authentification:', userError.message);
    }
  } else {
    console.log('🚶 Mode anonyme - pas de token fourni');
  }
  // Client avec SERVICE_ROLE pour contourner RLS lors de l'insertion
  const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  // Récupère le body (form-data)
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return new Response('Bad Request: must be multipart/form-data', {
      status: 400,
      headers: corsHeaders
    });
  }
  // Récupère la langue depuis les headers (défaut: français)
  const language = req.headers.get('x-language') || req.headers.get('accept-language')?.split(',')[0]?.split('-')[0] || 'fr';
  console.log('🌍 Langue détectée:', language);
  const anonymousId = req.headers.get('x-anonymous-id') || null;
  console.log('👤 Anonymous ID:', anonymousId);
  // Récupère d'abord l'organe et prépare le form-data pour PlantNet
  let organ = 'leaf';
  let plantnetFormData;
  let originalImageBase64 = null;
  let isGardenSave = true; // Indique si c'est une sauvegarde pour le jardin
  try {
    const formData = await req.formData();
    organ = formData.get('organs') || 'leaf';
    isGardenSave = formData.get('garden') === 'true'; // Paramètre spécial pour les sauvegardes jardin
    // Recrée un nouveau FormData pour PlantNet
    plantnetFormData = new FormData();
    const images = formData.getAll('images');
    images.forEach((image)=>{
      // Vérifie si c'est un string (base64) ou un fichier
      if (typeof image === 'string') {
        // C'est du base64, on le sauvegarde pour plus tard
        originalImageBase64 = image;
        // Convertit en Blob pour PlantNet
        const base64Data = image;
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for(let i = 0; i < byteCharacters.length; i++){
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([
          byteArray
        ], {
          type: 'image/jpeg'
        });
        plantnetFormData.append('images', blob, 'image.jpg');
      } else {
        // C'est un fichier, on l'ajoute directement
        plantnetFormData.append('images', image);
      }
    });
    plantnetFormData.append('organs', organ);
  } catch (e) {
    console.error('Erreur parsing formData:', e);
    return new Response('Bad Request: invalid form data', {
      status: 400,
      headers: corsHeaders
    });
  }
  // Forward le form-data à PlantNet
  console.log('🌿 Appel PlantNet API...');
  const apiKey = Deno.env.get("PlantNet");
  const project = 'all';
  const url = `https://my-api.plantnet.org/v2/identify/${project}?api-key=${apiKey}`;
  const plantnetRes = await fetch(url, {
    method: 'POST',
    body: plantnetFormData
  });
  console.log('📥 Réponse PlantNet:', plantnetRes.status, plantnetRes.statusText);
  const resBody = await plantnetRes.arrayBuffer();
  // On tente de parser la réponse JSON (sinon on stocke le buffer brut)
  let plantnetJson = null;
  try {
    const text = new TextDecoder().decode(resBody);
    plantnetJson = JSON.parse(text);
  } catch (e) {
  // ignore, on ne stockera rien si ce n'est pas du JSON
  }
  // Insertion en base si JSON parsé (utilisateur connecté OU anonyme)
  if (plantnetJson && (user || anonymousId)) {
    // Ne garde que le premier résultat (le plus probable)
    const bestResult = plantnetJson.results?.[0];
    if (bestResult) {
      const simplifiedResult = {
        bestMatch: plantnetJson.bestMatch,
        predictedOrgans: plantnetJson.predictedOrgans,
        result: bestResult // Seulement le premier résultat
      };
      // Sauvegarde l'image si disponible
      let imageUrl = null;
      if (originalImageBase64) {
        try {
          // Upload vers Supabase Storage (l'image est déjà compressée côté client)
          const ownerId = user?.id ?? anonymousId ?? 'anonymous';
          imageUrl = await uploadImageToStorage(originalImageBase64, ownerId, supabaseAdmin);
        } catch (imageError) {
          console.error('❌ Erreur sauvegarde image:', imageError);
        // Continue sans l'image si ça échoue
        }
      }
      const { error: insertError } = await supabaseAdmin.from('plant_identifications').insert({
        user_id: user ? user.id : null,
        anonymous_id: user ? null : anonymousId,
        result: simplifiedResult,
        organ,
        image_url: imageUrl,
        language: language,
        in_garden: isGardenSave,
        created_at: new Date().toISOString()
      });
      if (insertError) {
        console.error('Erreur insertion plant_identifications:', insertError.message);
      } else {
        console.log('✅ Identification sauvegardée avec image:', imageUrl ? 'oui' : 'non', 'langue:', language, 'anonyme:', !user);
        // Envoi d'une notif vers Make (webhook)
        try {
          const makeUrl = 'https://hook.eu2.make.com/h0ztjejy9rg35r2y898kzbyx5jhhgmvy';
          await fetch(makeUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              type: 'plant_identification',
              user: user ? user.id : null,
              email: user?.email || null,
              anonymous: !user,
              anonymous_id: user ? null : anonymousId,
              organ,
              bestMatch: plantnetJson?.bestMatch,
              in_garden: isGardenSave,
              language,
              image_url: imageUrl || null,
              timestamp: new Date().toISOString()
            })
          });
          console.log('📡 Notif envoyée à Make');
        } catch (err) {
          console.error('❌ Erreur envoi webhook Make:', err);
        }
      }
      // Enrichit la réponse anonyme avec l'URL de l'image si disponible
      if (!user && plantnetJson) {
        try {
          plantnetJson.image_url = imageUrl;
        } catch (_) {}
      }
    }
  } else if (plantnetJson && !user) {
    console.log('ℹ️ Utilisateur non connecté: identification effectuée sans sauvegarde cloud (pas d\'anonymousId fourni).');
  }
  // Pour les utilisateurs anonymes, on enrichit la réponse avec des informations utiles
  if (plantnetJson && !user) {
    // Ajoute des métadonnées utiles pour les utilisateurs anonymes
    plantnetJson.anonymous = true;
    plantnetJson.message = language === 'fr' ? 'Identification réussie. Connectez-vous pour sauvegarder vos identifications.' : 'Identification successful. Sign in to save your identifications.';
  }
  // Retourne la réponse appropriée selon le type d'utilisateur
  if (plantnetJson && !user) {
    // Pour les utilisateurs anonymes, on retourne le JSON modifié
    console.log('📤 Retour réponse anonyme avec statut:', plantnetRes.status);
    return new Response(JSON.stringify(plantnetJson), {
      status: plantnetRes.status,
      headers: {
        'content-type': 'application/json',
        ...corsHeaders
      }
    });
  } else {
    // Pour les utilisateurs connectés ou en cas d'erreur, on retourne la réponse originale
    console.log('📤 Retour réponse utilisateur connecté avec statut:', plantnetRes.status);
    return new Response(resBody, {
      status: plantnetRes.status,
      headers: {
        'content-type': plantnetRes.headers.get('content-type') || 'application/json',
        ...corsHeaders
      }
    });
  }
});
