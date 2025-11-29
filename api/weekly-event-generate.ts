// pages/api/weekly-event-generate.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { initFirebaseAdmin, getDb } from "../../lib/firebaseAdmin";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

type RatingDoc = {
  tmdbId: number;
  overall: number;
};

type TmdbMovieBasic = {
  tmdbId: number;
  title: string;
  year?: string;
  posterUrl?: string;
};

type WeeklyEventDoc = {
  eventId: string;
  createdAt: string;
  startVoteDate: string;
  endVoteDate: string;
  status: "voting" | "chosen" | "finished";
  theme: string;
  aiIntro: string;
  candidates: {
    tmdbId: number;
    title: string;
    year?: string;
    posterUrl?: string;
    aiPitch: string;
  }[];
};

type ApiResponse =
  | { error: string; info?: string }
  | { event: WeeklyEventDoc };

// ------- Helpers TMDB -------

async function fetchMovieBasicFromTmdb(tmdbId: number): Promise<TmdbMovieBasic> {
  if (!TMDB_API_KEY) {
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
  const title: string = json.title || `Película ${tmdbId}`;
  const releaseDate: string | undefined = json.release_date;
  const year =
    releaseDate && releaseDate.length >= 4
      ? releaseDate.slice(0, 4)
      : undefined;

  const posterPath: string | undefined = json.poster_path || undefined;
  const posterUrl = posterPath
    ? `https://image.tmdb.org/t/p/w500${posterPath}`
    : undefined;

  return {
    tmdbId,
    title,
    year,
    posterUrl,
  };
}

// Buscar una peli en TMDB por título (y opcionalmente año) para conseguir tmdbId
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

// ------- Handler principal -------

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Método no permitido" });
    }

    // 🔐 mini auth opcional
    const secretFromReq =
      (req.query.secret as string) || (req.body && (req.body as any).secret);
    const expectedSecret = process.env.WEEKLY_EVENT_SECRET;
    if (expectedSecret && secretFromReq !== expectedSecret) {
      return res.status(401).json({ error: "No autorizado" });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Gemini no está configurado (falta GEMINI_API_KEY).",
      });
    }

    initFirebaseAdmin();
    const db = getDb();

    // 1) Leer todas las valoraciones globales
    const ratingsSnap = await db.collection("ratings").get();

    if (ratingsSnap.empty) {
      return res.status(400).json({
        error: "No hay valoraciones aún en la app.",
        info: "Crea eventos cuando haya al menos algunas valoraciones.",
      });
    }

    const statsMap = new Map<number, { sum: number; count: number }>();

    ratingsSnap.forEach((doc) => {
      const data = doc.data();
      const tmdbId = (data.tmdbId ?? 0) as number;
      const overall = (data.overall ?? 0) as number;

      if (!tmdbId || typeof tmdbId !== "number") return;
      if (typeof overall !== "number") return;

      const current = statsMap.get(tmdbId) ?? { sum: 0, count: 0 };
      current.sum += overall;
      current.count += 1;
      statsMap.set(tmdbId, current);
    });

    if (statsMap.size === 0) {
      return res.status(400).json({
        error: "No hay datos suficientes de ratings para crear evento.",
      });
    }

    // 2) Ranking global (media descendente, mínimo X votos)
    let ranked = Array.from(statsMap.entries())
      .map(([tmdbId, { sum, count }]) => ({
        tmdbId,
        avg: sum / count,
        count,
      }))
      .filter((x) => x.count >= 2); // mínimo 2 votos

    if (!ranked.length) {
      return res.status(400).json({
        error:
          "No hay suficientes pelis con votos para crear un ranking global.",
      });
    }

    ranked.sort((a, b) => b.avg - a.avg);

    // ✔️ Nos quedamos con top 80 para describir los gustos del club
    const topForPrompt = ranked.slice(0, 80);
    const rankedIds = new Set(topForPrompt.map((r) => r.tmdbId));

    const rankingText = topForPrompt
      .map(
        (r, idx) =>
          `#${idx + 1} tmdbId=${r.tmdbId} | media=${r.avg.toFixed(
            2
          )} | votos=${r.count}`
      )
      .join("\n");

    // 3) PROMPT A GEMINI:
    //    Usa el ranking como "foto de gustos", pero NO puede elegir pelis del ranking.
    const systemPrompt = `
Eres el programador de un cineclub semanal.

Tienes un ranking global de las películas mejor valoradas por un grupo de amigos,
pero NO quieres reutilizar esas mismas películas.
Vas a usar ese ranking solo como "mapa de gustos" para entender:

- Qué tono y tipo de historias suelen gustar.
- Si tienden más a cine comercial, autor, terror, drama, comedia, etc.

TU TAREA:

1) Elegir una temática interesante para la semana.
   Ejemplos (NO te limites a estos):
   - "Semana de terror psicológico"
   - "Semana de giros inesperados"
   - "Semana de comedia feel-good"
   - "Semana de historias que te destrozan el corazón"
   - "Semana de ciencia ficción existencial"
   - "Semana de cine infravalorado que casi nadie ha visto"

2) Proponer 3 PELÍCULAS que NO estén en la lista del ranking.
   - Deben ser películas REALES que encajen con los gustos que intuyes por el ranking.
   - Idealmente, que no sean las típicas ultra-mainstream,
     sino cosas que "merece mucho la pena descubrir".

3) Para cada película, escribe un texto (3–6 frases) en español:
   - Explica por qué encaja con la temática.
   - Explica por qué crees que le puede gustar a esta comunidad concreta,
     enlazando con el tipo de cine que aparece en el ranking:
     ritmo, tono, profundidad, guion, emociones, fotografía, etc.

4) Escribe también una intro general del evento de la semana:
   - Título de la temática.
   - Pequeño texto para animar a votar una de las 3 pelis,
     usando un tono cercano y entusiasta.

Reglas:

- NO puedes recomendar ninguna película que aparezca en el ranking (por tmdbId).
- No inventes títulos inexistentes.
- No hables de APIs, tmdb, ni nada técnico.
- No añadas texto fuera del JSON.
`;

    const userPrompt = `
Este es el ranking global (top ${topForPrompt.length}):

${rankingText}

IMPORTANTE:
- Todas estas pelis forman parte del ranking de la comunidad.
- NO debes recomendar ninguna de ellas.
- Úsalas solo para entender qué tipo de cine les gusta.

Devuélvelo TODO EN ESTE FORMATO JSON EXACTO, sin texto adicional:

{
  "theme": "Semana de ...",
  "intro": "Texto en español para presentar el evento...",
  "candidates": [
    {
      "title": "Nombre de la película 1",
      "year": 2017,
      "aiPitch": "Texto en español explicando por qué esta peli encaja muy bien en la temática y con los gustos de este grupo..."
    },
    {
      "title": "Nombre de la película 2",
      "year": 2019,
      "aiPitch": "..."
    },
    {
      "title": "Nombre de la película 3",
      "year": 2003,
      "aiPitch": "..."
    }
  ]
}
`;

    const promptText = systemPrompt + "\n\n" + userPrompt;

    const geminiResp = await fetch(
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

    if (!geminiResp.ok) {
      const textErr = await geminiResp.text();
      console.error("Gemini weekly-event status:", geminiResp.status, textErr);
      return res.status(500).json({
        error: "Gemini no ha podido generar el evento.",
        info: textErr,
      });
    }

    const geminiJson: any = await geminiResp.json();
    const parts = geminiJson.candidates?.[0]?.content?.parts ?? [];
    const textPart: string = parts.map((p: any) => p.text || "").join("\n");

    let parsed: {
      theme?: string;
      intro?: string;
      candidates?: { title?: string; year?: number | string; aiPitch?: string }[];
    } = {};

    try {
      parsed = JSON.parse(textPart);
    } catch (e) {
      console.error("Error parseando JSON de Gemini (evento):", e, textPart);
      const match = textPart.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch (e2) {
          console.error("Parseo 2 fallido:", e2);
        }
      }
    }

    const theme = (parsed.theme || "").toString().trim();
    const intro = (parsed.intro || "").toString().trim();
    const candidatesRaw = Array.isArray(parsed.candidates)
      ? parsed.candidates
      : [];

    if (!theme || !intro || candidatesRaw.length === 0) {
      return res.status(500).json({
        error:
          "Gemini devolvió un evento incompleto (sin theme/intro/candidates).",
      });
    }

    // Nos quedamos con máximo 3 propuestas
    const raw = candidatesRaw.slice(0, 3);

    // 4) Enriquecer propuestas:
    //    - Buscar tmdbId en TMDB por título+year
    //    - Filtrar si por error Gemini recomienda algo que ya está en ranking
    const enriched: WeeklyEventDoc["candidates"] = [];

    for (const c of raw) {
      const title = (c.title || "").toString().trim();
      if (!title) continue;

      const year = c.year;
      const pitch = (c.aiPitch || "").toString().trim();
      if (!pitch) continue;

      let tmdbId: number | undefined;
      try {
        tmdbId = await searchMovieOnTmdb(title, year);
      } catch (e) {
        console.error("Error buscando tmdbId para", title, e);
        continue;
      }

      if (!tmdbId) continue;

      // ⚠️ Aseguramos que NO esté en el ranking
      if (rankedIds.has(tmdbId)) {
        console.warn(
          `Gemini propuso ${title} (tmdbId=${tmdbId}), pero está en el ranking. La descartamos.`
        );
        continue;
      }

      const basic = await fetchMovieBasicFromTmdb(tmdbId);

      enriched.push({
        tmdbId: basic.tmdbId,
        title: basic.title,
        year: basic.year,
        posterUrl: basic.posterUrl,
        aiPitch: pitch,
      });
    }

    if (!enriched.length) {
      return res.status(500).json({
        error:
          "No se ha podido generar ninguna candidata nueva que no esté ya en el ranking.",
      });
    }

    // 5) Crear ID de evento y fechas
    const now = new Date();
    const createdAt = now.toISOString();

    const year = now.getUTCFullYear();
    const oneJan = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil(
      ((+now - +oneJan) / (1000 * 60 * 60 * 24) + oneJan.getUTCDay() + 1) / 7
    );
    const eventId = `${year}-w${week.toString().padStart(2, "0")}`;

    const endVote = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
    const startVoteDate = createdAt;
    const endVoteDate = endVote.toISOString();

    const eventDoc: WeeklyEventDoc = {
      eventId,
      createdAt,
      startVoteDate,
      endVoteDate,
      status: "voting",
      theme,
      aiIntro: intro,
      candidates: enriched,
    };

    await db.collection("weeklyEvents").doc(eventId).set(eventDoc);

    return res.status(200).json({ event: eventDoc });
  } catch (e: any) {
    console.error("Error general en /weekly-event-generate:", e);
    return res.status(500).json({
      error: "Error interno creando el evento semanal.",
      info: e?.message ?? "unknown",
    });
  }
}
