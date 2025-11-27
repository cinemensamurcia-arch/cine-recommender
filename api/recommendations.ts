// pages/api/recommendations.ts
import type { NextApiRequest, NextApiResponse } from "next";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// Lo que llega desde la app
type IncomingRating = {
  tmdbId: number;
  overall: number;
  guion: number;
  direccion: number;
  actuacion: number;
  bso: number;
  disfrute: number;
  title?: string;
  year?: string;
};

// Lo que respondemos a la app
export type AiRecommendation = {
  tmdbId?: number;
  title: string;
  reason: string;
};

type ApiResponse =
  | { error: string; info?: string }
  | { recommendations: AiRecommendation[]; info?: string };

// Normalizar títulos: minúsculas, sin año, sin signos típicos
function normalizeTitle(raw: string | undefined | null): string {
  if (!raw) return "";
  let t = raw.toLowerCase().trim();

  // Quitar " (1994)" o cualquier paréntesis final
  t = t.replace(/\s*\([^)]*\)\s*$/g, "");
  // Quitar espacios duplicados
  t = t.replace(/\s+/g, " ");
  // Quitar signos sencillos
  t = t.replace(/[:\-–_]/g, "").trim();

  return t;
}

// Obtener título y año desde TMDB a partir de tmdbId
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

// Fallback: si la IA no devuelve nada útil, tiramos de TMDB "popular"
// y filtramos las pelis que ya has visto
async function fallbackPopularFromTmdb(
  seenIds: number[],
  max: number
): Promise<AiRecommendation[]> {
  const result: AiRecommendation[] = [];

  try {
    if (!TMDB_API_KEY) {
      console.error("Falta TMDB_API_KEY, no se puede usar fallbackPopularFromTmdb");
      return [];
    }

    const resp = await fetch(
      `https://api.themoviedb.org/3/movie/popular?api_key=${TMDB_API_KEY}&language=es-ES&page=1`
    );

    if (!resp.ok) {
      console.error("TMDB popular error status:", resp.status);
      return [];
    }

    const data: any = await resp.json();
    const results: any[] = Array.isArray(data?.results) ? data.results : [];

    const seenSet = new Set(seenIds);

    for (const m of results) {
      if (result.length >= max) break;

      const id: number = m.id;
      if (!id || seenSet.has(id)) continue;

      const title: string = m.title ?? "";
      if (!title.trim()) continue;

      const overview: string = m.overview ?? "";
      const vote: number = typeof m.vote_average === "number" ? m.vote_average : 0;
      const releaseDate: string = m.release_date ?? "";
      const year =
        releaseDate && releaseDate.length >= 4
          ? releaseDate.substring(0, 4)
          : "";

      // Razones un poco más humanas (aunque no sean hiper personalizadas)
      const fragments: string[] = [];

      if (vote >= 7.5) {
        fragments.push(
          `Es una película muy bien valorada por el público, con una media de alrededor de ${vote.toFixed(
            1
          )}/10.`
        );
      } else if (vote > 0) {
        fragments.push(
          `Tiene una recepción bastante positiva entre la gente, con una puntuación media cercana a ${vote.toFixed(
            1
          )}/10.`
        );
      }

      if (overview) {
        fragments.push(
          `La historia que cuenta suele enganchar por su planteamiento y la manera en que desarrolla a sus personajes.`
        );
      }

      if (year) {
        fragments.push(
          `Además, al ser de ${year}, mantiene un estilo y un ritmo que siguen funcionando muy bien hoy en día.`
        );
      } else {
        fragments.push(
          `Su mezcla de ritmo, tono y atmósfera la hace una buena candidata para una sesión de cine que se disfrute sin complicaciones.`
        );
      }

      if (!fragments.length) {
        fragments.push(
          `Es una de las películas populares del momento y puede encajar bien como próxima opción si buscas algo entretenido.`
        );
      }

      const reason = fragments.join(" ");

      result.push({
        tmdbId: id,
        title,
        reason,
      });
    }
  } catch (e) {
    console.error("Error en fallbackPopularFromTmdb:", e);
    return [];
  }

  return result;
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

    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error:
          "Falta configurar GEMINI_API_KEY en el backend. No se pueden generar recomendaciones con IA.",
      });
    }

    // 0) Enriquecer ratings con título y año desde TMDB (si hace falta)
    const ratings: IncomingRating[] = await Promise.all(
      rawRatings.map(async (r) => {
        if (r.title || !TMDB_API_KEY) return r;

        const extra = await fetchTitleYearFromTmdb(r.tmdbId);

        return {
          ...r,
          title: r.title ?? extra.title,
          year: r.year ?? extra.year,
        };
      })
    );

    // Conjunto de títulos YA vistos (normalizados)
    const ratedTitlesSet = new Set(
      ratings
        .map((r) => normalizeTitle(r.title))
        .filter((t) => t.length > 0)
    );

    // Conjunto de tmdbIds YA vistos
    const ratedIds = ratings
      .map((r) => r.tmdbId)
      .filter((id) => typeof id === "number" && id > 0);

    const ratedIdsSet = new Set(ratedIds);

    // 1) Preparar texto de valoraciones para el prompt
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

Objetivo:
- Recomendar SOLO películas que el usuario NO haya visto todavía.
- Las películas que aparecen en su lista de valoraciones son PELÍCULAS YA VISTAS.
- Bajo ninguna circunstancia debes recomendar como "nueva" una película que ya esté en esa lista.

Criterios:
- Analiza las notas de "overall", pero da un peso especial a:
  - "disfrute" (qué tanto la disfrutó).
  - "guion" (calidad de la historia).
- Usa también dirección, actuación y banda sonora para detectar patrones de gustos.
- Recomienda películas con un tono, ritmo, emociones o tipo de historia afines a las mejor valoradas,
  pero que NO estén repetidas.

Estilo de la respuesta:
- Devuelve SIEMPRE JSON puro, sin texto adicional, con el formato EXACTO:

{
  "recommendations": [
    { "tmdbId": 13, "title": "Forrest Gump", "reason": "..." }
  ]
}

- En "reason" escribe de 2 a 4 frases en español, naturales y humanas.
- Varía el estilo entre una recomendación y otra: habla de emociones, tono, ritmo, personajes,
  tipo de mensaje, atmósfera, etc.
- NO uses frases tipo "Te la recomiendo porque la valoraste con un 10/10".
- Prohibido que todas las "reason" sigan la misma plantilla.
`;

    const userPrompt = `
Usuario con uid=${uid}.

Estas son algunas de sus valoraciones (PELÍCULAS YA VISTAS, NO RECOMENDAR ESTAS):

${userMoviesForPrompt}

Listado resumido de títulos ya vistos:
${seenTitlesList || "(sin títulos conocidos)"}

Tarea:
- Devuélveme hasta ${max} películas que NO estén en la lista de ya vistas.
- Si conoces el "tmdbId" de la película recomendada, inclúyelo. Si no lo conoces, puedes omitirlo.
- En "reason" explica por qué crees que le gustará, conectando con lo que disfruta:
  tipo de historia, profundidad emocional, ritmo, humor, giros de guion, etc.
- No repitas ninguna película que ya aparezca en la lista de valoraciones.
- No incluyas explicaciones fuera del JSON.
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

        // 👉 Fallback a TMDB popular
        const fallback = await fallbackPopularFromTmdb(ratedIds, max);
        return res.status(200).json({
          recommendations: fallback,
          info:
            "La IA no ha podido responder correctamente; se han usado recomendaciones populares de TMDB.",
        });
      }

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

      let cleaned = arr.filter(
        (r) => r && r.title && r.title.toString().trim().length > 0
      );

      // Filtrar lo que YA has visto (por título normalizado y/o tmdbId)
      cleaned = cleaned.filter((r) => {
        const tNorm = normalizeTitle(r.title);
        if (!tNorm) return false;

        if (ratedTitlesSet.has(tNorm)) return false;
        if (r.tmdbId && ratedIdsSet.has(r.tmdbId)) return false;

        return true;
      });

      finalRecs = cleaned.slice(0, max);

      if (!finalRecs.length) {
        // 👉 Si después de filtrar no queda nada, fallback TMDB
        const fallback = await fallbackPopularFromTmdb(ratedIds, max);
        return res.status(200).json({
          recommendations: fallback,
          info:
            "La IA ha respondido, pero todas las pelis parecían vistas o inválidas; se han usado recomendaciones populares de TMDB.",
        });
      }
    } catch (e) {
      console.error("Error al llamar a Gemini:", e);
      const fallback = await fallbackPopularFromTmdb(ratedIds, max);
      return res.status(200).json({
        recommendations: fallback,
        info:
          "La IA no ha podido generar recomendaciones; se han usado recomendaciones populares de TMDB.",
      });
    }

    return res.status(200).json({
      recommendations: finalRecs,
      info: "Recomendaciones IA generadas correctamente.",
    });
  } catch (e: any) {
    console.error("Error general en /api/recommendations:", e);
    return res.status(500).json({
      error: "Error interno en el servidor.",
      info: e?.message ?? "unknown",
    });
  }
}

