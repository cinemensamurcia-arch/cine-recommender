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
};

// Lo que devolvemos a la app
export type AiRecommendation = {
  tmdbId: number;
  title: string;
  reason: string;
};

type ApiResponse =
  | { error: string; info?: string }
  | { recommendations: AiRecommendation[]; info?: string };

// ------------ Helpers TMDB ------------

// Obtener título, año y sinopsis de una película
async function fetchMovieBasicFromTmdb(
  tmdbId: number
): Promise<{ title?: string; year?: string; overview?: string }> {
  try {
    if (!TMDB_API_KEY) return {};

    const resp = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=es-ES`
    );

    if (!resp.ok) {
      console.error("TMDB movie error status:", tmdbId, resp.status);
      return {};
    }

    const data: any = await resp.json();
    const title: string | undefined = data?.title;
    const releaseDate: string | undefined = data?.release_date;
    const year =
      releaseDate && releaseDate.length >= 4
        ? releaseDate.substring(0, 4)
        : undefined;
    const overview: string | undefined = data?.overview;

    return { title, year, overview };
  } catch (e) {
    console.error("Error llamando a TMDB detalle:", tmdbId, e);
    return {};
  }
}

// Obtener recomendadas desde TMDB para una peli base
async function fetchRecommendedFromTmdb(
  baseId: number,
  baseTitle: string,
  seenIds: Set<number>,
  maxPerBase: number
): Promise<
  { tmdbId: number; title: string; year?: string; overview?: string; fromTitle: string }[]
> {
  const list: {
    tmdbId: number;
    title: string;
    year?: string;
    overview?: string;
    fromTitle: string;
  }[] = [];

  try {
    if (!TMDB_API_KEY) return list;

    const resp = await fetch(
      `https://api.themoviedb.org/3/movie/${baseId}/recommendations?api_key=${TMDB_API_KEY}&language=es-ES&page=1`
    );

    if (!resp.ok) {
      console.error("TMDB recommendations status:", baseId, resp.status);
      return list;
    }

    const data: any = await resp.json();
    const results: any[] = Array.isArray(data?.results) ? data.results : [];

    for (const m of results) {
      if (list.length >= maxPerBase) break;

      const id: number = m.id;
      if (!id || seenIds.has(id)) continue;

      const title: string = m.title ?? "";
      if (!title.trim()) continue;

      const releaseDate: string = m.release_date ?? "";
      const year =
        releaseDate && releaseDate.length >= 4
          ? releaseDate.substring(0, 4)
          : undefined;
      const overview: string | undefined = m.overview;

      list.push({
        tmdbId: id,
        title,
        year,
        overview,
        fromTitle: baseTitle,
      });
    }
  } catch (e) {
    console.error("Error en fetchRecommendedFromTmdb:", e);
  }

  return list;
}

// Fallback: si Gemini falla, tiramos de recomendaciones TMDB de forma directa
async function fallbackSimpleFromTmdb(
  topRatings: IncomingRating[],
  max: number,
  seenIds: Set<number>
): Promise<AiRecommendation[]> {
  const result: AiRecommendation[] = [];

  for (const r of topRatings) {
    if (result.length >= max) break;

    const baseInfo = await fetchMovieBasicFromTmdb(r.tmdbId);
    const baseTitle = baseInfo.title ?? `Película ${r.tmdbId}`;

    const recs = await fetchRecommendedFromTmdb(
      r.tmdbId,
      baseTitle,
      seenIds,
      5
    );

    for (const rec of recs) {
      if (result.length >= max) break;
      if (seenIds.has(rec.tmdbId)) continue;
      if (result.some((x) => x.tmdbId === rec.tmdbId)) continue;

      const reason =
        `Te puede encajar si te gustó "${baseTitle}", ` +
        `porque comparte cierto tono y tipo de historia. ` +
        `Además es una recomendación directa basada en los gustos de gente que también disfrutó "${baseTitle}".`;

      result.push({
        tmdbId: rec.tmdbId,
        title: rec.title,
        reason,
      });
    }
  }

  return result;
}

// ------------ Handler principal ------------

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Método no permitido" });
    }

    const { uid, ratings, maxItems } = req.body as {
      uid?: string;
      ratings?: IncomingRating[];
      maxItems?: number;
    };

    if (!uid || !Array.isArray(ratings)) {
      return res
        .status(400)
        .json({ error: "uid y ratings (array) son obligatorios" });
    }

    if (ratings.length === 0) {
      return res.status(200).json({
        recommendations: [],
        info: "Usuario sin valoraciones aún.",
      });
    }

    const max = typeof maxItems === "number" && maxItems > 0 ? maxItems : 15;

    if (!GEMINI_API_KEY || !TMDB_API_KEY) {
      return res.status(500).json({
        error:
          "Faltan GEMINI_API_KEY o TMDB_API_KEY en el backend. No se pueden generar recomendaciones.",
      });
    }

    // 1) Ordenamos las pelis por lo que más disfrutan
    const sorted = [...ratings].sort((a, b) => {
      // Primero por disfrute, luego por nota global
      if (b.disfrute !== a.disfrute) return b.disfrute - a.disfrute;
      return b.overall - a.overall;
    });

    // Tomamos las 5 mejores como "pelis base"
    const baseMovies = sorted.slice(0, Math.min(5, sorted.length));

    // Conjunto de tmdbIds ya vistos
    const seenIds = new Set(
      ratings
        .map((r) => r.tmdbId)
        .filter((id) => typeof id === "number" && id > 0)
    );

    // 2) Obtenemos recomendaciones TMDB para cada peli base
    const candidates: {
      tmdbId: number;
      title: string;
      year?: string;
      overview?: string;
      fromTitle: string;
    }[] = [];

    const usedIds = new Set<number>();

    for (const r of baseMovies) {
      const baseInfo = await fetchMovieBasicFromTmdb(r.tmdbId);
      const baseTitle = baseInfo.title ?? `Película ${r.tmdbId}`;

      const recs = await fetchRecommendedFromTmdb(
        r.tmdbId,
        baseTitle,
        seenIds,
        10 // máximo por peli base
      );

      for (const rec of recs) {
        if (usedIds.has(rec.tmdbId)) continue;
        usedIds.add(rec.tmdbId);
        candidates.push(rec);
      }
    }

    if (!candidates.length) {
      // Si TMDB no devuelve nada útil, devolvemos fallback muy básico
      const fb = await fallbackSimpleFromTmdb(baseMovies, max, seenIds);
      return res.status(200).json({
        recommendations: fb,
        info: "No se encontraron recomendaciones en TMDB; se ha usado un fallback básico.",
      });
    }

    // 3) Preparamos el contexto para la IA
    const topForPrompt = baseMovies.slice(0, 10);

    const userMoviesForPrompt = topForPrompt
      .map((r) => {
        return `tmdbId=${r.tmdbId}: general ${r.overall}/10, guion ${r.guion}/10, dirección ${r.direccion}/10, actuación ${r.actuacion}/10, BSO ${r.bso}/10, disfrute ${r.disfrute}/10`;
      })
      .join("\n");

    const candidatesForPrompt = candidates
      .map((c) => {
        return `- tmdbId=${c.tmdbId}, título="${c.title}"${
          c.year ? ` (${c.year})` : ""
        }, recomendada por TMDB a partir de "${c.fromTitle}". Sinopsis: ${
          c.overview ?? "(sin sinopsis disponible)"
        }`;
      })
      .join("\n");

   const systemPrompt = `
Eres un recomendador de cine para un grupo de amigos.

Tienes:

1) Una lista de valoraciones del usuario (con notas a:
   - guion
   - dirección
   - actuación
   - banda sonora
   - disfrute general)

2) Una lista de PELÍCULAS CANDIDATAS que vienen de las recomendaciones de TMDB
   a partir de películas que el usuario ha valorado muy bien.

TU TAREA:

- Elegir hasta N películas de esa lista de CANDIDATAS.
- Para cada recomendación, escribir una explicación en español, de varias frases
  (3–6 frases), natural y humana, de por qué crees que le va a gustar al usuario.
- Usa un tono cercano, como si hablaras directamente a la persona: "tú".
- Debes tener en cuenta:
  - Qué tipo de historias disfruta (según las notas).
  - Si valora más el guion, el disfrute, las actuaciones, la BSO, etc.
  - El tono emocional, el ritmo, el tipo de personajes, los temas, la fotografía…

INSTRUCCIONES CLAVE PARA LAS EXPLICACIONES:

- En cada recomendación:
  - Menciona explícitamente al menos UNA de las películas que ha visto,
    del estilo: "Como te gustó el guion de X…", "Igual que en X, aquí también…".
  - Di cosas concretas: habla de guion, personajes, ritmo, atmósfera, humor,
    fotografía, música, temas que trata, cómo se siente al verla, etc.
  - Relaciona la recomendación con sus gustos:
    - Si el usuario suele poner nota alta al guion, resalta el guion.
    - Si suele valorar mucho el disfrute, habla de lo entretenida que es.
    - Si valora la BSO, menciona la música.
- Varía el estilo:
  - En unas recomendaciones céntrate más en la emoción.
  - En otras, en el guion.
  - En otras, en las actuaciones o la dirección.
  - Evita repetir la misma estructura o frases tipo plantilla.

REGLAS IMPORTANTES:

- SOLO puedes usar las películas que te doy en la lista de CANDIDATAS.
- NO inventes títulos nuevos.
- NO recomiendes películas que no estén listadas.
- NO menciones TMDB ni que vienen de una API.
- NO digas frases tipo "Te la recomiendo porque la valoraste con X/10".
- No expliques el proceso ni hables de "modelo", "IA", "prompt" ni nada técnico.
- No añadas frases tipo "como modelo de lenguaje..." ni nada por el estilo.
- No añadas texto fuera del JSON.

FORMATO DE RESPUESTA (OBLIGATORIO):

Devuelve SIEMPRE JSON puro con este formato EXACTO:

{
  "recommendations": [
    { "tmdbId": 13, "title": "Forrest Gump", "reason": "Texto en español..." }
  ]
}
`;


    const userPrompt = `
Usuario con uid=${uid}.

Estas son algunas de sus valoraciones (para que veas qué le gusta y qué valora):

${userMoviesForPrompt}

Donde:
- "overall" es la nota general.
- "guion", "direccion", "actuacion", "bso" y "disfrute" indican qué aspectos
  valora más en cada película.

Estas son las películas CANDIDATAS (todas recomendadas por TMDB a partir de pelis que le gustaron):

${candidatesForPrompt}

INSTRUCCIONES ESPECÍFICAS PARA ESTE USUARIO:

- Elige SOLO entre esas CANDIDATAS.
- Piensa qué le gustó de las películas que ya ha visto:
  - Si suele poner notas altas al guion, dale importancia a historias bien escritas.
  - Si valora mucho el disfrute, busca pelis con buen ritmo y que enganchen.
  - Si cuida la actuación, destaca interpretaciones potentes.
  - Si valora la música, resalta la BSO cuando tenga sentido.
- En cada recomendación:
  - Menciona al menos una de las películas que ha visto ("Como te gustó X…").
  - Explica en 3–6 frases por qué esta película nueva encaja con sus gustos
    (guion, tono, actuaciones, fotografía, banda sonora, ritmo, emoción, temas…).
  - Haz que cada "reason" suene distinta, natural y humana, sin plantillas repetidas.

Devuélveme hasta ${max} recomendaciones con este formato EXACTO, sin texto adicional:

{
  "recommendations": [
    { "tmdbId": 123, "title": "Nombre", "reason": "Texto en español..." }
  ]
}
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

        // Fallback directo con TMDB (sin IA bonita)
        const fb = await fallbackSimpleFromTmdb(baseMovies, max, seenIds);
        return res.status(200).json({
          recommendations: fb,
          info: "Gemini falló; se han usado recomendaciones directas de TMDB como fallback.",
        });
      }

      const geminiJson: any = await geminiResponse.json();
      const candidatesG = geminiJson.candidates ?? [];
      const textPart =
        candidatesG[0]?.content?.parts?.[0]?.text ??
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

      // Validamos y filtramos a las pelis que realmente estaban entre las candidatas
      const candidateIdsSet = new Set(candidates.map((c) => c.tmdbId));

      finalRecs = arr
        .filter(
          (r) =>
            r &&
            typeof r.tmdbId === "number" &&
            candidateIdsSet.has(r.tmdbId) &&
            typeof r.title === "string" &&
            r.title.trim().length > 0 &&
            typeof r.reason === "string" &&
            r.reason.trim().length > 0
        )
        .slice(0, max);

      if (!finalRecs.length) {
        // Si no ha generado nada útil, fallback simple
        const fb = await fallbackSimpleFromTmdb(baseMovies, max, seenIds);
        return res.status(200).json({
          recommendations: fb,
          info:
            "Gemini respondió, pero no generó recomendaciones válidas; se ha usado un fallback básico.",
        });
      }
    } catch (e) {
      console.error("Error al llamar a Gemini:", e);
      const fb = await fallbackSimpleFromTmdb(baseMovies, max, seenIds);
      return res.status(200).json({
        recommendations: fb,
        info:
          "Error al usar Gemini; se han usado recomendaciones directas de TMDB como fallback.",
      });
    }

    return res.status(200).json({
      recommendations: finalRecs,
      info: "Recomendaciones generadas con TMDB + IA.",
    });
  } catch (e: any) {
    console.error("Error general en /api/recommendations:", e);
    return res.status(500).json({
      error: "Error interno en el servidor.",
      info: e?.message ?? "unknown",
    });
  }
}




