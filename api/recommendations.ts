// pages/api/recommendations.ts
import type { NextApiRequest, NextApiResponse } from "next";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY; // o pon tu key fija si quieres

// --------- Tipos que envía tu app Android ---------
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

// Lo que tu backend devuelve a Android
export type AiRecommendation = {
  tmdbId?: number;
  title: string;
  reason: string;
};

type ApiResponse =
  | { error: string; info?: string }
  | { recommendations: AiRecommendation[]; info?: string };

// --------- Helpers TMDB ---------

type TmdbMovieBasic = {
  tmdbId: number;
  title: string;
  year?: string;
  overview?: string;
};

async function fetchMovieBasicFromTmdb(tmdbId: number): Promise<TmdbMovieBasic> {
  if (!TMDB_API_KEY) {
    // Si no hay key, devolvemos algo mínimo para que no rompa
    return {
      tmdbId,
      title: `Película ${tmdbId}`,
    };
  }

  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=es-ES`;
  const resp = await fetch(url);

  if (!resp.ok) {
    console.error("TMDB /movie error", resp.status, await resp.text());
    return {
      tmdbId,
      title: `Película ${tmdbId}`,
    };
  }

  const json = await resp.json();
  const title = json.title || `Película ${tmdbId}`;
  const releaseDate: string | undefined = json.release_date;
  const year = releaseDate && releaseDate.length >= 4 ? releaseDate.slice(0, 4) : undefined;
  const overview: string | undefined = json.overview;

  return {
    tmdbId,
    title,
    year,
    overview,
  };
}

async function fetchRecommendedFromTmdb(
  baseTmdbId: number,
  baseTitle: string,
  seenIds: Set<number>,
  limitPerBase: number
): Promise<TmdbMovieBasic[]> {
  if (!TMDB_API_KEY) return [];

  const url = `https://api.themoviedb.org/3/movie/${baseTmdbId}/recommendations?api_key=${TMDB_API_KEY}&language=es-ES&page=1`;
  const resp = await fetch(url);

  if (!resp.ok) {
    console.error("TMDB /recommendations error", resp.status, await resp.text());
    return [];
  }

  const json = await resp.json();
  const results: any[] = json.results || [];

  const list: TmdbMovieBasic[] = [];

  for (const r of results) {
    if (list.length >= limitPerBase) break;

    const id = r.id;
    if (!id || typeof id !== "number") continue;
    if (seenIds.has(id)) continue;

    const title = r.title || r.original_title || `Película ${id}`;
    const date: string | undefined = r.release_date;
    const year = date && date.length >= 4 ? date.slice(0, 4) : undefined;
    const overview: string | undefined = r.overview;

    list.push({
      tmdbId: id,
      title,
      year,
      overview,
    });
  }

  return list;
}

// Fallback sencillo (por si Gemini PETA de verdad)
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

// --------- Handler principal ---------

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

    // Ordenamos por nota global (mejores arriba)
    const sortedByOverall = [...ratings].sort(
      (a, b) => b.overall - a.overall
    );

    // IDs que el usuario ya ha visto (para no repetir)
    const seenIds = new Set<number>(ratings.map((r) => r.tmdbId));

    // ------------------------------
    // 1) Construir CANDIDATAS desde TMDB
    // ------------------------------

    const topForTmdb = sortedByOverall.slice(0, 10); // p.ej. sus 10 mejor valoradas
    const candidateMap = new Map<number, TmdbMovieBasic>();

    for (const r of topForTmdb) {
      const baseInfo = await fetchMovieBasicFromTmdb(r.tmdbId);
      const recs = await fetchRecommendedFromTmdb(
        r.tmdbId,
        baseInfo.title,
        seenIds,
        10
      );
      for (const rec of recs) {
        if (candidateMap.size >= 80) break; // máximo 80 candidatas totales
        if (seenIds.has(rec.tmdbId)) continue; // no recomendar vistas
        if (candidateMap.has(rec.tmdbId)) continue;
        candidateMap.set(rec.tmdbId, rec);
      }
    }

    const candidateMovies = Array.from(candidateMap.values());

    if (!candidateMovies.length) {
      // Si por lo que sea TMDB no devuelve nada, usamos fallback simple
      const fb = await fallbackSimpleFromTmdb(sortedByOverall, max, seenIds);
      return res.status(200).json({
        recommendations: fb,
        info: "TMDB no ha devuelto candidatas, usando fallback simple.",
      });
    }

    // Texto con valoraciones del usuario para el prompt
    const subsetForPrompt = sortedByOverall.slice(0, 80);

    const userMoviesForPrompt = subsetForPrompt
      .map((r) => {
        const namePart = r.title
          ? `${r.title} (${r.year ?? "?"})`
          : `Película con tmdbId=${r.tmdbId}`;
        return `${namePart}: general ${r.overall}/10, guion ${r.guion}/10, dirección ${r.direccion}/10, actuación ${r.actuacion}/10, BSO ${r.bso}/10, disfrute ${r.disfrute}/10`;
      })
      .join("\n");

    // Texto con candidatas para el prompt
    const candidatesForPrompt = candidateMovies
      .map((m) => {
        const yearText = m.year ? ` (${m.year})` : "";
        const ov = m.overview ? m.overview.slice(0, 250) : "";
        return `- [${m.tmdbId}] ${m.title}${yearText}: ${ov}`;
      })
      .join("\n");

    // ------------------------------
    // 2) Si no hay GEMINI_API_KEY → error claro (no fallback silencioso)
    // ------------------------------
    if (!GEMINI_API_KEY) {
      console.error("Falta GEMINI_API_KEY en el entorno de Vercel");
      return res.status(500).json({
        error:
          "Gemini no está configurado en el servidor (falta GEMINI_API_KEY).",
        info: "Configura GEMINI_API_KEY en Vercel y vuelve a desplegar.",
      });
    }

    // ------------------------------
    // 3) Prompt para Gemini
    // ------------------------------

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
- No añadas texto fuera del JSON.

FORMATO DE RESPUESTA (OBLIGATORIO):

Devuelve SIEMPRE JSON puro con este formato EXACTO:

{
  "recommendations": [
    { "tmdbId": 13, "title": "Forrest Gump", "reason": "..." }
  ]
}
`;

    const userPrompt = `
Usuario con uid=${uid}.

Estas son algunas de sus valoraciones (para que veas qué le gusta y qué valora):

${userMoviesForPrompt}

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

    const promptText = systemPrompt + "\n\n" + userPrompt;

    // ------------------------------
    // 4) Llamada REAL a Gemini
    // ------------------------------
    let finalRecs: AiRecommendation[] = [];

    try {
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: promptText }],
              },
            ],
          }),
        }
      );

      if (!geminiResponse.ok) {
        console.error("Gemini status:", geminiResponse.status);
        const textErr = await geminiResponse.text();
        console.error("Gemini body:", textErr);

        // Si Gemini responde mal, usamos fallback simple
        const fb = await fallbackSimpleFromTmdb(sortedByOverall, max, seenIds);
        return res.status(200).json({
          recommendations: fb,
          info: `Gemini devolvió ${geminiResponse.status}, usando fallback.`,
        });
      }

      const geminiJson: any = await geminiResponse.json();
      const candidates = geminiJson.candidates ?? [];
      const parts = candidates[0]?.content?.parts ?? [];
      const textPart: string = parts.map((p: any) => p.text || "").join("\n");

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

      finalRecs = arr.filter(
        (r) => r && r.title && r.title.toString().trim().length > 0
      );

      if (!finalRecs.length) {
        // Si Gemini no devuelve nada usable → fallback
        const fb = await fallbackSimpleFromTmdb(sortedByOverall, max, seenIds);
        return res.status(200).json({
          recommendations: fb,
          info: "Gemini devolvió recomendaciones vacías, usando fallback.",
        });
      }
    } catch (e) {
      console.error("Error al llamar a Gemini:", e);
      const fb = await fallbackSimpleFromTmdb(sortedByOverall, max, seenIds);
      return res.status(200).json({
        recommendations: fb,
        info: "Excepción al llamar a Gemini, usando fallback.",
      });
    }

    return res.status(200).json({
      recommendations: finalRecs.slice(0, max),
      info: "Recomendaciones devueltas por Gemini (con filtrado).",
    });
  } catch (e: any) {
    console.error("Error general en /api/recommendations:", e);
    return res.status(500).json({
      error: "Error interno en el servidor.",
      info: e?.message ?? "unknown",
    });
  }
}





