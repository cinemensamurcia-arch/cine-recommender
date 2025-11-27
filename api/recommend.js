// /api/recommendations/route.ts  (Vercel Edge/Node)
import type { NextRequest } from "next/server";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Tipos que vienen desde tu app
type IncomingRating = {
  tmdbId: number;
  title: string;
  year?: string;
  overall: number;
  guion: number;
  direccion: number;
  actuacion: number;
  bso: number;
  disfrute: number;
};

type AiRecommendation = {
  tmdbId?: number;
  title: string;
  reason: string;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const uid = body.uid as string | undefined;
    const ratings = body.ratings as IncomingRating[] | undefined;
    const maxItems = (body.maxItems as number | undefined) ?? 15;

    if (!uid || !ratings || !Array.isArray(ratings)) {
      return new Response(
        JSON.stringify({ error: "uid y ratings (array) son obligatorios" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (ratings.length === 0) {
      return new Response(
        JSON.stringify({
          recommendations: [],
          info: "Usuario sin valoraciones aún.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 1) FALBACK LOCAL: top N pelis según tu propia media
    const sortedByOverall = [...ratings].sort(
      (a, b) => b.overall - a.overall
    );
    const localFallback: AiRecommendation[] = sortedByOverall
      .slice(0, Math.min(maxItems, sortedByOverall.length))
      .map((r) => ({
        tmdbId: r.tmdbId,
        title: r.title,
        reason: `Te la recomiendo porque la valoraste con un ${r.overall}/10 y encaja mucho con tu estilo.`,
      }));

    // Si no hay API key de Gemini, devolvemos directamente el fallback local
    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({
          recommendations: localFallback,
          info: "Devueltas sólo recomendaciones locales (sin IA).",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2) Llamada a Gemini para intentar enriquecer/mejorar las recomendaciones
    const userMoviesForPrompt = ratings
      .slice(0, 80) // límite para no pasarnos
      .map(
        (r) =>
          `- ${r.title} (${r.year ?? "?"}): general ${r.overall}/10, guion ${r.guion}/10, dirección ${r.direccion}/10, actuación ${r.actuacion}/10, BSO ${r.bso}/10, disfrute ${r.disfrute}/10`
      )
      .join("\n");

    const systemPrompt = `
Eres un recomendador de cine para un grupo de amigos. 
Tienes que recomendar películas basándote en las valoraciones del usuario.

Responde SIEMPRE en JSON *puro* con este formato EXACTO:

{
  "recommendations": [
    { "tmdbId": 13, "title": "Forrest Gump", "reason": "..." },
    { "tmdbId": 272, "title": "El padrino", "reason": "..." }
  ]
}

- "tmdbId" puede ser 0 si no lo conoces, pero intenta usar uno real si lo sabes.
- "title" es obligatorio.
- "reason" debe explicar por qué se la recomiendas, usando sus gustos.
`;

    const userPrompt = `
Usuario con uid=${uid}

Estas son algunas de sus valoraciones (máximo 80):

${userMoviesForPrompt}

Devuélveme hasta ${maxItems} recomendaciones variadas, con "tmdbId" si lo conoces, "title" y "reason" clara y breve.
`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: systemPrompt }] },
            { role: "user", parts: [{ text: userPrompt }] },
          ],
        }),
      }
    );

    if (!geminiResponse.ok) {
      console.error("Gemini error status:", geminiResponse.status);
      const text = await geminiResponse.text();
      console.error("Gemini error body:", text);
      // Devolvemos fallback
      return new Response(
        JSON.stringify({
          recommendations: localFallback,
          info: "Se ha usado fallback local por error al llamar a Gemini.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const geminiJson = await geminiResponse.json();
    const candidates = geminiJson.candidates ?? [];
    if (!candidates.length) {
      console.warn("Gemini sin candidates. Usando fallback local.");
      return new Response(
        JSON.stringify({
          recommendations: localFallback,
          info: "Gemini no devolvió candidatos, usando fallback local.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const textPart =
      candidates[0]?.content?.parts?.[0]?.text ??
      JSON.stringify({ recommendations: [] });

    let parsed: { recommendations?: AiRecommendation[] } = {};
    try {
      parsed = JSON.parse(textPart);
    } catch (e) {
      console.error("Error al parsear JSON de Gemini:", e, textPart);
      // texto venía con cosas extra; intentamos recortar
      const match = textPart.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch (e2) {
          console.error("Parseo 2 fallido:", e2);
        }
      }
    }

    let finalRecs = Array.isArray(parsed.recommendations)
      ? parsed.recommendations
      : [];

    // Filtrado básico: al menos título
    finalRecs = finalRecs.filter((r) => r && r.title && r.title.trim().length > 0);

    // Si tras todo esto no hay ninguna, usamos fallback local
    if (!finalRecs.length) {
      finalRecs = localFallback;
    }

    return new Response(
      JSON.stringify({
        recommendations: finalRecs.slice(0, maxItems),
        info: "Recomendaciones generadas con IA (con fallback local si hacía falta).",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("Error general en /api/recommendations:", e);
    return new Response(
      JSON.stringify({ error: "Error interno en el servidor." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
