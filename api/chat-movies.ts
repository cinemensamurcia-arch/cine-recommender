/// <reference types="node" />

// api/chat-movies.ts h

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// --------- Tipos compartidos con tu app ---------

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

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type AiChatMovie = {
  tmdbId?: number;
  title: string;
  year?: number | string;
  comment: string;
  posterUrl?: string;
};

type ApiResponse =
  | { error: string; info?: string }
  | { reply: string; movies: AiChatMovie[]; info?: string };

// --------- Helpers TMDB ---------

async function searchMovieOnTmdb(
  title: string,
  year?: string | number
): Promise<{ tmdbId?: number; posterUrl?: string }> {
  if (!TMDB_API_KEY) return {};

  const query = encodeURIComponent(title);
  const yearParam =
    year != null ? `&year=${encodeURIComponent(year.toString())}` : "";

  const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&language=es-ES&query=${query}${yearParam}&page=1&include_adult=false`;

  const resp = await fetch(url);
  if (!resp.ok) {
    console.error("TMDB /search error", resp.status, await resp.text());
    return {};
  }

  const json = await resp.json();
  const results: any[] = json.results || [];
  if (!results.length) return {};

  const best = results[0];
  const tmdbId = typeof best.id === "number" ? best.id : undefined;
  const posterPath: string | undefined = best.poster_path;
  const posterUrl = posterPath
    ? `https://image.tmdb.org/t/p/w500${posterPath}`
    : undefined;

  return { tmdbId, posterUrl };
}

// --------- Handler principal ---------

// 👇 IMPORTANTE: sin tipos de Next, usamos `any` para Vercel serverless
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
      messages,
      pendingTmdbIds,
      pending,
    } = req.body as {
      uid?: string;
      ratings?: IncomingRating[];
      messages?: ChatMessage[];
      pendingTmdbIds?: number[];
      pending?: IncomingPending[];
    };

    if (!uid || !Array.isArray(messages)) {
      return res
        .status(400)
        .json({ error: "uid y messages (array) son obligatorios" });
    }

    const ratingsOrEmpty: IncomingRating[] = Array.isArray(ratings)
      ? ratings
      : [];

    // ------------------------------
    // Construir gustos + pelis vistas/pedientes (mismo enfoque que /recommendations)
    // ------------------------------

    // IDs vistas
    const seenIds = new Set<number>(ratingsOrEmpty.map((r) => r.tmdbId));

    // Títulos vistos (para filtrado por título)
    const seenTitlesLower = new Set(
      ratingsOrEmpty
        .map((r) => r.title?.toLowerCase().trim())
        .filter((t): t is string => !!t)
    );

    // Pendientes por título
    const pendingTitlesLower = new Set<string>();
    if (Array.isArray(pending)) {
      for (const p of pending) {
        if (!p?.title) continue;
        const t = p.title.toLowerCase().trim();
        if (t) pendingTitlesLower.add(t);
      }
    }

    // Pendientes por tmdbId (incluyendo los que vengan en pending + pendingTmdbIds)
    const pendingIds = new Set<number>(
      (pendingTmdbIds ?? []).filter(
        (x) => typeof x === "number" && !Number.isNaN(x)
      )
    );

    if (Array.isArray(pending)) {
      for (const p of pending) {
        if (p?.tmdbId && typeof p.tmdbId === "number" && !Number.isNaN(p.tmdbId)) {
          pendingIds.add(p.tmdbId);
        }
      }
    }

    // (Opcional) Resolver tmdbId de pendientes por título si tienes TMDB_API_KEY
    if (Array.isArray(pending) && TMDB_API_KEY) {
      for (const p of pending) {
        if (!p?.title) continue;
        try {
          const { tmdbId } = await searchMovieOnTmdb(p.title, p.year);
          if (tmdbId && !Number.isNaN(tmdbId)) {
            pendingIds.add(tmdbId);
          }
        } catch (e) {
          console.error("Error resolviendo tmdbId de pendiente", p.title, e);
        }
      }
    }

    // Conjunto final de IDs bloqueados (vistas + pendientes)
    const blockedIds = new Set<number>();
    seenIds.forEach((id) => blockedIds.add(id));
    pendingIds.forEach((id) => blockedIds.add(id));

    // Conjunto final de títulos bloqueados (vistas + pendientes)
    const blockedTitlesLower = new Set<string>();
    seenTitlesLower.forEach((t) => blockedTitlesLower.add(t));
    pendingTitlesLower.forEach((t) => blockedTitlesLower.add(t));

    // ------------------------------
    // Resumen de gustos para el prompt
    // ------------------------------
    const subsetForPrompt = ratingsOrEmpty.slice(0, 80);
    const userMoviesForPrompt =
      subsetForPrompt.length > 0
        ? subsetForPrompt
            .map((r) => {
              const namePart = r.title
                ? `${r.title} (${r.year ?? "?"})`
                : `Película con tmdbId=${r.tmdbId}`;
              return `${namePart}: general ${r.overall}/10, guion ${r.guion}/10, dirección ${r.direccion}/10, actuación ${r.actuacion}/10, BSO ${r.bso}/10, disfrute ${r.disfrute}/10`;
            })
            .join("\n")
        : "El usuario aún no tiene valoraciones.";

    const pendingListForPrompt =
      blockedTitlesLower.size > 0
        ? `\nEstas películas el usuario YA LAS HA VISTO o las tiene en PENDIENTES (NO las recomiendes):\n${[
            ...blockedTitlesLower,
          ]
            .map((t) => `- ${t}`)
            .join("\n")}\n`
        : "";

    // ------------------------------
    // Historial del chat
    // ------------------------------
    const lastMessages = messages.slice(-10);
    const conversationText = lastMessages
      .map((m) =>
        m.role === "user"
          ? `Usuario: ${m.content}`
          : `Asistente: ${m.content}`
      )
      .join("\n");

    // ------------------------------
    // Prompt para Gemini
    // ------------------------------

    const systemPrompt = `
Eres un asistente de cine dentro de una app de películas.

REGLA FUNDAMENTAL (MUY IMPORTANTE):
- SOLO puedes hablar de cine y de recomendaciones de PELÍCULAS.
- Cine = películas, directores, guion, fotografía, bandas sonoras, actores, géneros, historia del cine, anécdotas de rodaje, curiosidades, análisis de escenas, "clases" de cine, etc.
- NO puedes hablar de otros temas: nada de salud, política, dinero, relaciones, tecnología, programación, religión, psicología, etc.
- Si el usuario te pregunta algo fuera de cine, responde SIEMPRE de esta forma:
  "En este chat solo puedo hablar de cine y recomendar películas 😊. Cuéntame qué tipo de película te apetece ver o de qué peli quieres hablar."

INFORMACIÓN SOBRE EL USUARIO:

- Estas son algunas de sus valoraciones (para que veas qué le gusta y qué valora):
${userMoviesForPrompt}

- Además, hay una lista de películas que YA HA VISTO o las tiene en PENDIENTES (no las recomiendes):
${pendingListForPrompt}

REGLAS SOBRE RECOMENDACIONES:

- Puedes:
  - Hablar de anécdotas de películas concretas.
  - Explicar curiosidades de rodaje.
  - Dar "clases" de cine (estructura, dirección, fotografía, historia del cine).
  - Analizar escenas o finales (sin inventar datos falsos).
  - Y, cuando tenga sentido, recomendar nuevas películas.
- SIEMPRE que recomiendes películas nuevas:
  - Deben ser PELÍCULAS REALES.
  - Deben encajar lo mejor posible con sus gustos (según las notas que pone a guion, dirección, actuaciones, BSO, disfrute).
  - NO DEBEN estar en la lista de películas ya vistas ni en las pendientes que te he pasado (ni por título ni por sensación de “es la misma peli”).

FORMATO DE RESPUESTA (OBLIGATORIO SIEMPRE):

Devuelve SIEMPRE un JSON con este formato exacto:

{
  "reply": "texto en español hablando al usuario de tú, tono cercano",
  "movies": [
    {
      "title": "Nombre de la película",
      "year": 1999,
      "comment": "Por qué la mencionas o recomiendas (2-4 frases)."
    }
  ]
}

- "movies" puede ser una lista vacía [] si solo estás charlando de una peli concreta o respondiendo algo sin proponer nuevas.
- NO añadas texto fuera del JSON.
`;

    const userPrompt = `
Esta es la conversación hasta ahora entre el Usuario y el Asistente:

${conversationText}

Responde AHORA al ÚLTIMO mensaje del usuario siguiendo todas las reglas anteriores.
Recuerda:
- SOLO cine.
- Puedes hablar, explicar, dar contexto, anécdotas, etc.
- Si recomiendas películas nuevas, respeta los gustos y NO repitas películas vistas o pendientes.
- Usa SIEMPRE el formato JSON indicado, sin texto adicional fuera del JSON.
`;

    if (!GEMINI_API_KEY) {
      console.error("Falta GEMINI_API_KEY en el entorno");
      return res.status(500).json({
        error: "Gemini no está configurado en el servidor.",
        info: "Configura GEMINI_API_KEY.",
      });
    }

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: systemPrompt + "\n\n" + userPrompt }],
            },
          ],
        }),
      }
    );

    if (!geminiResponse.ok) {
      const textErr = await geminiResponse.text();
      console.error("Gemini chat error:", geminiResponse.status, textErr);
      return res.status(500).json({
        error: "Error llamando a Gemini.",
        info: textErr,
      });
    }

    const geminiJson: any = await geminiResponse.json();
    const candidates = geminiJson.candidates ?? [];
    const parts = candidates[0]?.content?.parts ?? [];
    const textPart: string = parts.map((p: any) => p.text || "").join("\n");

    let parsed: {
      reply?: string;
      movies?: { title: string; year?: number | string; comment: string }[];
    } = {};

    try {
      parsed = JSON.parse(textPart);
    } catch (e) {
      console.error("Error parseando JSON de Gemini (chat):", e, textPart);
      const match = textPart.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch (e2) {
          console.error("Parseo 2 fallido chat:", e2);
        }
      }
    }

    const reply =
      parsed.reply ||
      "Ha habido un problema interpretando la respuesta. Pídeme otra cosa de cine 😉.";
    const moviesRaw = Array.isArray(parsed.movies) ? parsed.movies : [];

    // Enriquecer y FILTRAR recomendaciones por vistas/pendientes
    const movies: AiChatMovie[] = [];
    for (const m of moviesRaw) {
      if (!m.title) continue;

      const titleLower = m.title.toString().toLowerCase().trim();
      if (!titleLower) continue;
      if (blockedTitlesLower.has(titleLower)) {
        // Título ya visto o pendiente → lo saltamos
        continue;
      }

      const { tmdbId, posterUrl } = await searchMovieOnTmdb(m.title, m.year);

      if (tmdbId && blockedIds.has(tmdbId)) {
        // También bloqueado por ID → lo saltamos
        continue;
      }

      movies.push({
        tmdbId,
        title: m.title,
        year: m.year,
        comment: m.comment,
        posterUrl,
      });
    }

    return res.status(200).json({
      reply,
      movies,
      info: "Respuesta generada por el chat de cine IA (filtrando vistas y pendientes).",
    });
  } catch (e: any) {
    console.error("Error general en /api/chat-movies:", e);
    return res.status(500).json({
      error: "Error interno en el servidor.",
      info: e?.message ?? "unknown",
    });
  }
}
