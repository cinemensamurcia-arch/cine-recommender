// pages/api/recommendations.ts
import type { NextApiRequest, NextApiResponse } from "next";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// Lo que tú mandas desde la app
type IncomingRating = {
  tmdbId: number;
  overall: number;
  guion: number;
  direccion: number;
  actuacion: number;
  bso: number;
  disfrute: number;
  title?: string; // lo rellenaremos desde TMDB si no viene
  year?: string;
};

// Lo que devolverá el endpoint a tu app
export type AiRecommendation = {
  tmdbId?: number;
  title: string;
  reason: string;
};

type ApiResponse =
  | { error: string; info?: string }
  | { recommendations: AiRecommendation[]; info?: string };

// 🔧 Normalizar títulos: minúsculas, sin año entre paréntesis, sin signos típicos
function normalizeTitle(raw: string | undefined | null): string {
  if (!raw) return "";
  let t = raw.toLowerCase().trim();

  // Quitar " (1994)" o cualquier paréntesis al final
  t = t.replace(/\s*\([^)]*\)\s*$/g, "");

  // Quitar espacios duplicados
  t = t.replace(/\s+/g, " ");

  // Quitar algunos signos de puntuación simples
  t = t.replace(/[:\-–_]/g, "").trim();

  return t;
}

// 🔧 Obtener título y año desde TMDB según tmdbId
async function fetchTitleYearFromTmdb(
  tmdbId: number
): Promise<{ title?: string; year?: string }> {
  try {
    if (!TMDB_API_KEY) return {};

    const resp = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=es-ES`
    );

    if (!resp.ok) {
      console.error("TMDB error status para", tmdbId, resp.status);
      return {};
    }

    const data: any = await resp.json();
    const title: string | undefined = data?.title;
    const releaseDate: string | undefined = data?.release_date;
    const year =
      releaseDate && releaseDate.length >= 4
        ? releaseDate.substring(0, 4)
        : undefined;

    return { title, year };
  } catch (e) {
    console.error("Error llamando a TMDB para", tmdbId, e);
    return {};
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Método no permitido" });
    }

    const { uid, ratings: rawRatings, maxItems } = req.body as {
      uid?: string;
      ratings?: IncomingRating[];
      maxItems?: number;
    };

    if (!uid || !Array.isArray(rawRatings)) {
      return res
        .status(400)
        .json({ error: "uid y ratings (array) son obligatorios" });
    }

    if (rawRatings.length === 0) {
      return res.status(200).json({
        recommendations: [],
        info: "Usuario sin valoraciones aún.",
      });
    }

    const max = typeof maxItems === "number" && maxItems > 0 ? maxItems : 15;

    // 0) Enriquecemos los ratings con título/año desde TMDB si hace falta
    const ratings: IncomingRating[] = await Promise.all(
      rawRatings.map(async (r) => {
        // Si ya viene título, lo respetamos
        if (r.title || !TMDB_API_KEY) return r;

        const extra = await fetchTitleYearFromTmdb(r.tmdbId);

        return {
          ...r,
          title: r.title ?? extra.title,
          year: r.year ?? extra.year,
        };
      })
    );

    // 🔹 Conjunto de títulos YA vistos normalizados
    const ratedTitlesSet = new Set(
      ratings
        .map((r) => normalizeTitle(r.title))
        .filter((t) => t.length > 0)
    );

    // 🔹 Conjunto de tmdbIds YA vistos
    const ratedIdsSet = new Set(
      ratings
        .map((r) => r.tmdbId)
        .filter((id) => typeof id === "number" && id > 0)
    );

    // 1) Fallback local: ordenar por nota global (esto puede repetir vistas, es solo por si IA falla)
    const sortedByOverall = [...ratings].sort(
      (a, b) => b.overall - a.overall
    );

    const localFallback: AiRecommendation[] = sortedByOverall
      .slice(0, Math.min(max, sortedByOverall.length))
      .map((r) => ({
        tmdbId: r.tmdbId,
        title: r.title ?? `Película ${r.tmdbId}`,
        reason: `Te la recomiendo porque la valoraste con un ${r.overall}/10 (guion ${r.guion}/10, disfrute ${r.disfrute}/10).`,
      }));

    // Si NO hay API key de Gemini, devolvemos solo fallback
    if (!GEMINI_API_KEY) {
      return res.status(200).json({
        recommendations: localFallback,
        info: "Devueltas solo recomendaciones locales (sin IA, falta GEMINI_API_KEY).",
      });
    }

    // 2) Preparamos prompt para Gemini con ratings enriquecidos
    const subsetForPrompt = ratings.slice(0, 80);

    const userMoviesForPrompt = subsetForPrompt
      .map((r) => {
        const namePart = r.title
          ? `${r.title} (${r.year ?? "?"})`
          : `Película con tmdbId=${r.tmdbId}`;
        return `${namePart}: general ${r.overall}/10, guion ${r.guion}/10, dirección ${r.direccion}/10, actuación ${r.actuacion}/10, BSO ${r.bso}/10, disfrute ${r.disfrute}/10`;
      })
      .join("\n");

    const seenTitlesList = subsetForPrompt
      .map((r) => r.title)
      .filter((t): t is string => !!t && t.trim().length > 0)
      .join(", ");

    const systemPrompt = `
Eres un recomendador de cine para un grupo de amigos.
Tu objetivo es recomendar películas NUEVAS al usuario basándote en lo que ya ha visto y valorado.

Tienes que tener en cuenta:
- Las valoraciones generales, pero especialmente:
  - "disfrute" (qué tanto disfrutó la película).
  - "guion" (calidad de la historia).
- Otros campos (dirección, actuación, BSO) también ayudan a reconocer patrones de gustos.

Muy importante:
- Las películas que ya aparecen en la lista de valoraciones del usuario SON PELÍCULAS YA VISTAS.
- No vuelvas a recomendarlas como si fueran nuevas.
- Recomienda OTRAS películas distintas, que encajen con sus gustos.
- Si quieres, puedes mencionar la relación con las ya vistas en la explicación ("reason"), pero NO las repitas como recomendación principal.

Responde SIEMPRE en JSON puro con este formato EXACTO (sin texto extra):

{
  "recommendations": [
    { "tmdbId": 13, "title": "Forrest Gump", "reason": "..." }
  ]
}
`;

    const userPrompt = `
Usuario con uid=${uid}

Estas son algunas de sus valoraciones (películas YA VISTAS):

${userMoviesForPrompt}

Listado breve de títulos ya vistos:
${seenTitlesList || "(sin títulos conocidos)"}

Tarea:
- Devuélveme hasta ${max} recomendaciones VARIADAS de películas que NO estén en esa lista de ya vistas.
- Ten MUY en cuenta sobre todo el "disfrute" y el "guion" para saber qué tipo de historias le gustan.
- En "reason" explica brevemente por qué se la recomiendas, mencionando si se parece en tono, tipo de guion, ritmo o sensaciones a alguna de las pelis mejor valoradas.
- Si conoces el "tmdbId" de la película, inclúyelo. Si no lo conoces, puedes omitirlo o poner null.
- No añadas nada fuera del JSON.
`;

    let finalRecs: AiRecommendation[] = [];

    try {
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
        console.error("Gemini status:", geminiResponse.status);
        const textErr = await geminiResponse.text();
        console.error("Gemini body:", textErr);
        finalRecs = localFallback;
      } else {
        const geminiJson: any = await geminiResponse.json();
        const candidates = geminiJson.candidates ?? [];
        const textPart =
          candidates[0]?.content?.parts?.[0]?.text ??
          JSON.stringify({ recommendations: [] });

        let parsed: { recommendations?: AiRecommendation[] } = {};

        try {
          parsed = JSON.parse(textPart);
        } catch (e) {
          console.error("Error parseando JSON de Gemini:", e, textPart);
          const match = textPart.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              parsed = JSON.parse(match[0]);
            } catch (e2) {
              console.error("Parseo 2 fallido:", e2);
            }
          }
        }

        const arr = Array.isArray(parsed.recommendations)
          ? parsed.recommendations
          : [];

        // 🔍 Filtramos recomendaciones sin título
        let cleaned = arr.filter(
          (r) => r && r.title && r.title.toString().trim().length > 0
        );

        // 🔍 NORMALIZAMOS título recomendado y filtramos los ya vistos
        cleaned = cleaned.filter((r) => {
          const tNorm = normalizeTitle(r.title);
          if (!tNorm) return false;

          // 1) Si el título normalizado ya está en las valoraciones → fuera
          if (ratedTitlesSet.has(tNorm)) return false;

          // 2) Si trae tmdbId y ya lo ha valorado → fuera
          if (r.tmdbId && ratedIdsSet.has(r.tmdbId)) return false;

          return true;
        });

        finalRecs = cleaned;

        if (!finalRecs.length) {
          finalRecs = localFallback;
        }
      }
    } catch (e) {
      console.error("Error al llamar a Gemini:", e);
      finalRecs = localFallback;
    }

    return res.status(200).json({
      recommendations: finalRecs.slice(0, max),
      info: "Recomendaciones devueltas (IA + fallback).",
    });
  } catch (e: any) {
    console.error("Error general en /api/recommendations:", e);
    return res.status(500).json({
      error: "Error interno en el servidor.",
      info: e?.message ?? "unknown",
    });
  }
}


