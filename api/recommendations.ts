// api/recommendations.ts

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

type IncomingPending = {
  tmdbId?: number;
  title?: string;
  year?: string | number;
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
  const year =
    releaseDate && releaseDate.length >= 4
      ? releaseDate.slice(0, 4)
      : undefined;
  const overview: string | undefined = json.overview;

  return {
    tmdbId,
    title,
    year,
    overview,
  };
}

// Sigue existiendo para el fallback,
// pero ya NO se usa en el flujo principal de Gemini.
async function fetchRecommendedFromTmdb(
  baseTmdbId: number,
  baseTitle: string,
  blockedIds: Set<number>, // ⬅️ vistas + pendientes
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
    if (blockedIds.has(id)) continue; // ⬅️ NO recomendar vistas ni pendientes

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

// Buscar una película en TMDB por título (y opcionalmente año)
// solo para recuperar el tmdbId, pero la recomendación en sí viene de Gemini.
async function searchMovieOnTmdb(
  title: string,
  year?: string | number
): Promise<number | undefined> {
  if (!TMDB_API_KEY) return undefined;

  const query = encodeURIComponent(title);
  const yearParam =
    typeof year === "string" || typeof year === "number"
      ? `&year=${encodeURIComponent(year.toString())}`
      : "";

  const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&language=es-ES&query=${query}${yearParam}&page=1&include_adult=false`;

  const resp = await fetch(url);
  if (!resp.ok) {
    console.error("TMDB /search error", resp.status, await resp.text());
    return undefined;
  }

  const json = await resp.json();
  const results: any[] = json.results || [];
  if (!results.length) return undefined;

  const best = results[0];
  if (!best.id || typeof best.id !== "number") return undefined;
  return best.id;
}

// Fallback sencillo (por si Gemini PETA de verdad)
async function fallbackSimpleFromTmdb(
  topRatings: IncomingRating[],
  max: number,
  blockedIds: Set<number> // vistas + pendientes
): Promise<AiRecommendation[]> {
  const result: AiRecommendation[] = [];

  for (const r of topRatings) {
    if (result.length >= max) break;

    const baseInfo = await fetchMovieBasicFromTmdb(r.tmdbId);
    const baseTitle = baseInfo.title ?? `Película ${r.tmdbId}`;

    const recs = await fetchRecommendedFromTmdb(
      r.tmdbId,
      baseTitle,
      blockedIds,
      5
    );

    for (const rec of recs) {
      if (result.length >= max) break;
      if (blockedIds.has(rec.tmdbId)) continue; // seguridad extra
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

// 👇 aquí quitamos Next y usamos `any` en req/res para Vercel serverless
export default async function handler(
  req: any,
  res: any
) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Método no permitido" });
    }

    const {
      uid,
      ratings,
      maxItems,
      pendingTmdbIds,
      pending,
    } = req.body as {
      uid?: string;
      ratings?: IncomingRating[];
      maxItems?: number;
      pendingTmdbIds?: number[];        // compatibilidad
      pending?: IncomingPending[];      // ⬅️ NUEVO: pendientes por título
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
    const sortedByOverall = [...ratings].sort((a, b) => b.overall - a.overall);

    // IDs que el usuario ya ha visto (para filtros y fallbacks)
    const seenIds = new Set<number>(ratings.map((r) => r.tmdbId));

    // Títulos vistos (para filtro por título)
    const seenTitlesLower = new Set(
      ratings
        .map((r) => r.title?.toLowerCase().trim())
        .filter((t): t is string => !!t)
    );

    // 🔹 NUEVO: pendientes por título
    const pendingTitlesLower = new Set<string>();
    if (Array.isArray(pending)) {
      for (const p of pending) {
        if (!p?.title) continue;
        const t = p.title.toLowerCase().trim();
        if (t) pendingTitlesLower.add(t);
      }
    }

    // 🔹 NUEVO: IDs de pelis pendientes (IDs + los que se puedan resolver por título)
    const pendingIds = new Set<number>(
      (pendingTmdbIds ?? []).filter(
        (x) => typeof x === "number" && !Number.isNaN(x)
      )
    );

    // Si nos llegan pendientes con tmdbId directo, los añadimos también
    if (Array.isArray(pending)) {
      for (const p of pending) {
        if (p?.tmdbId && typeof p.tmdbId === "number" && !Number.isNaN(p.tmdbId)) {
          pendingIds.add(p.tmdbId);
        }
      }
    }

    // Intentar resolver tmdbId a partir de título/año de pendientes (si hay API TMDB)
    if (Array.isArray(pending) && TMDB_API_KEY) {
      for (const p of pending) {
        if (!p?.title) continue;
        try {
          const id = await searchMovieOnTmdb(p.title, p.year);
          if (id && !Number.isNaN(id)) {
            pendingIds.add(id);
          }
        } catch (e) {
          console.error("Error resolviendo tmdbId de pendiente", p.title, e);
        }
      }
    }

    // 🔹 Conjunto final de IDs que NO se deben recomendar
    const blockedIds = new Set<number>();
    seenIds.forEach((id) => blockedIds.add(id));
    pendingIds.forEach((id) => blockedIds.add(id));

    // 🔹 Conjunto final de títulos que NO se deben recomendar
    const blockedTitlesLower = new Set<string>();
    seenTitlesLower.forEach((t) => blockedTitlesLower.add(t));
    pendingTitlesLower.forEach((t) => blockedTitlesLower.add(t));

    // ------------------------------
    // Texto con valoraciones del usuario para el prompt
    // ------------------------------
    const subsetForPrompt = sortedByOverall.slice(0, 80);

    const userMoviesForPrompt = subsetForPrompt
      .map((r) => {
        const namePart = r.title
          ? `${r.title} (${r.year ?? "?"})`
          : `Película con tmdbId=${r.tmdbId}`;
        return `${namePart}: general ${r.overall}/10, guion ${r.guion}/10, dirección ${r.direccion}/10, actuación ${r.actuacion}/10, BSO ${r.bso}/10, disfrute ${r.disfrute}/10`;
      })
      .join("\n");

    // Lista de pendientes para el prompt (solo texto informativo)
    const pendingListForPrompt =
      pendingTitlesLower.size > 0
        ? `\nEstas películas el usuario las tiene en su lista de PENDIENTES (no las recomiendes tampoco):\n${[
            ...pendingTitlesLower,
          ]
            .map((t) => `- ${t}`)
            .join("\n")}\n`
        : "";

    // ------------------------------
    //  Si no hay GEMINI_API_KEY → error claro
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
    //  Prompt para que Gemini genere NUEVAS películas
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
2) Una lista de películas que el usuario TIENE PENDIENTES de ver.

TU TAREA:

- Analizar qué le gusta realmente a esta persona:
  - Qué tipo de historias suele disfrutar.
  - Si valora más el guion, el disfrute, las actuaciones, la BSO, etc.
- A partir de eso, recomendarle NUEVAS películas que encajen con su perfil de gustos.
- Esas nuevas películas NO deben estar en la lista de películas que ya ha visto.
- Y TAMPOCO deben estar en su lista de "pendientes de ver".
- Cada recomendación debe ir acompañada de una explicación en español, de 3–6 frases,
  natural y humana, de por qué crees que le va a gustar.

TONO Y CONTENIDO:

- Usa un tono cercano, como si hablaras directamente a la persona: "tú".
- En cada recomendación:
  - Menciona explícitamente al menos UNA de las películas que ha visto,
    del estilo: "Como te gustó el guion de X…", "Igual que en X, aquí también…".
  - Di cosas concretas: guion, personajes, ritmo, atmósfera, humor,
    fotografía, música, temas que trata, cómo se siente al verla, etc.
  - Relaciona la recomendación con sus gustos:
    - Si el usuario suele poner nota alta al guion, resalta el guion.
    - Si suele valorar mucho el disfrute, habla de lo entretenida que es.
    - Si valora la BSO, menciona la música.
    - Si ves que suele fijarse en la dirección o la actuación, coméntalo.
- Varía el estilo:
  - En algunas recomendaciones céntrate más en la emoción.
  - En otras, en el guion.
  - En otras, en las actuaciones o la dirección.
  - Evita repetir la misma estructura o frases tipo plantilla.

REGLAS IMPORTANTES:

- SOLO puedes recomendar PELÍCULAS (no series) que NO aparezcan en la lista de películas que ya ha visto.
- Tampoco puedes recomendar películas que el usuario ya tenga en su lista de PENDIENTES.
- No inventes títulos inexistentes (deben ser películas reales).
- Puedes recomendar películas de cualquier país y época, siempre que encajen con sus gustos.
- No menciones plataformas, ni APIs, ni nada técnico.
- No expliques el proceso interno ni hables de "modelo", "IA" o "prompt".
- No añadas texto fuera del JSON.

FORMATO DE RESPUESTA (OBLIGATORIO):

Devuelve SIEMPRE JSON puro con este formato EXACTO:

{
  "recommendations": [
    { "title": "Forrest Gump", "year": 1994, "reason": "..." }
  ]
}
`;

    const userPrompt = `
Usuario con uid=${uid}.

Estas son algunas de sus valoraciones (para que veas qué le gusta y qué valora):

${userMoviesForPrompt}

${pendingListForPrompt}

RECORDEMOS:
- Todas las películas listadas arriba YA las ha visto.
- Además, tiene una lista de PENDIENTES cuyas películas también aparecen arriba (no las recomiendes).
- No vuelvas a recomendar ninguna de las películas que ya ha visto NI ninguna de las pendientes.

INSTRUCCIONES ESPECÍFICAS PARA ESTE USUARIO:

- Recomienda hasta ${max} películas.
- Tienen que ser películas REALES que no estén en la lista anterior (ni vistas ni pendientes).
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

Devuélveme las recomendaciones con este formato EXACTO, sin texto adicional:

{
  "recommendations": [
    { "title": "Nombre", "year": 1999, "reason": "Texto en español..." }
  ]
}
`;

    const promptText = systemPrompt + "\n\n" + userPrompt;

    // ------------------------------
    // Llamada REAL a Gemini
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
        const fb = await fallbackSimpleFromTmdb(sortedByOverall, max, blockedIds);
        return res.status(200).json({
          recommendations: fb,
          info: `Gemini devolvió ${geminiResponse.status}, usando fallback basado en TMDB.`,
        });
      }

      const geminiJson: any = await geminiResponse.json();
      const candidates = geminiJson.candidates ?? [];
      const parts = candidates[0]?.content?.parts ?? [];
      const textPart: string = parts.map((p: any) => p.text || "").join("\n");

      let parsed: {
        recommendations?: { title: string; year?: number | string; reason: string }[];
      } = {};

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

      const arr =
        Array.isArray(parsed.recommendations) ? parsed.recommendations : [];

      // Filtramos y limpiamos, evitando títulos ya vistos o pendientes
      const clean: { title: string; year?: number | string; reason: string }[] =
        arr.filter((r) => {
          if (!r || !r.title || !r.reason) return false;
          const titleLower = r.title.toString().toLowerCase().trim();
          if (!titleLower) return false;
          if (blockedTitlesLower.has(titleLower)) return false; // ⬅️ vistas + pendientes
          return true;
        });

      if (!clean.length) {
        // Si Gemini no devuelve nada usable → fallback
        const fb = await fallbackSimpleFromTmdb(sortedByOverall, max, blockedIds);
        return res.status(200).json({
          recommendations: fb,
          info: "Gemini devolvió recomendaciones vacías o repetidas, usando fallback basado en TMDB.",
        });
      }

      // Intentamos enriquecer con tmdbId usando búsqueda por título/año
      const enriched: AiRecommendation[] = [];
      for (const r of clean.slice(0, max)) {
        let tmdbId: number | undefined;
        try {
          tmdbId = await searchMovieOnTmdb(r.title, r.year);
        } catch (e) {
          console.error("Error buscando tmdbId para", r.title, e);
        }

        enriched.push({
          tmdbId,
          title: r.title,
          reason: r.reason,
        });
      }

      // FILTRO FINAL: no recomendar vistas ni pendientes por tmdbId
      finalRecs = enriched.filter((r) => {
        if (!r.tmdbId) return true; // si no sabemos id, no podemos filtrar por id
        return !blockedIds.has(r.tmdbId);
      });

      if (!finalRecs.length) {
        const fb = await fallbackSimpleFromTmdb(sortedByOverall, max, blockedIds);
        return res.status(200).json({
          recommendations: fb,
          info: "No se pudieron enriquecer recomendaciones de Gemini, usando fallback basado en TMDB.",
        });
      }
    } catch (e) {
      console.error("Error al llamar a Gemini:", e);
      const fb = await fallbackSimpleFromTmdb(sortedByOverall, max, blockedIds);
      return res.status(200).json({
        recommendations: fb,
        info: "Excepción al llamar a Gemini, usando fallback basado en TMDB.",
      });
    }

    return res.status(200).json({
      recommendations: finalRecs.slice(0, max),
      info: "Recomendaciones generadas por Gemini a partir de tus gustos (filtrando vistas y pendientes, con búsqueda opcional en TMDB para tmdbId).",
    });
  } catch (e: any) {
    console.error("Error general en /api/recommendations:", e);
    return res.status(500).json({
      error: "Error interno en el servidor.",
      info: e?.message ?? "unknown",
    });
  }
}







