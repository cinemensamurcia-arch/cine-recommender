// pages/api/weekly-event-generate.ts
import type { NextApiRequest, NextApiResponse } from "next";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// ---------- Tipos que usará la app Android ----------

type WeeklyCandidateDto = {
  tmdbId: number;
  title: string;
  year?: number;
};

type WeeklyEventDto = {
  id: string;
  theme: string;
  description: string;
  startVoteDate: string;
  endVoteDate: string;
  candidates: WeeklyCandidateDto[];
};

type ApiResponse =
  | { error: string; info?: string }
  | { event: WeeklyEventDto };

// ---------- Helpers TMDB ----------

type TmdbMovieBasic = {
  tmdbId: number;
  title: string;
  year?: number;
  overview?: string;
};

async function fetchTopRatedFromTmdb(limit: number): Promise<TmdbMovieBasic[]> {
  if (!TMDB_API_KEY) {
    console.error("Falta TMDB_API_KEY en el entorno");
    return [];
  }

  const url = `https://api.themoviedb.org/3/movie/top_rated?api_key=${TMDB_API_KEY}&language=es-ES&page=1`;
  const resp = await fetch(url);

  if (!resp.ok) {
    console.error("TMDB /top_rated error", resp.status, await resp.text());
    return [];
  }

  const json = await resp.json();
  const results: any[] = json.results || [];
  const list: TmdbMovieBasic[] = [];

  for (const r of results) {
    if (list.length >= limit) break;

    const id = r.id;
    if (!id || typeof id !== "number") continue;

    const title = r.title || r.original_title || `Película ${id}`;
    const date: string | undefined = r.release_date;
    const year =
      date && date.length >= 4 ? parseInt(date.slice(0, 4), 10) : undefined;
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

// ---------- Gemini: generar tema + descripción ----------

async function generateEventWithGemini(
  candidates: TmdbMovieBasic[]
): Promise<{ theme: string; description: string }> {
  if (!GEMINI_API_KEY) {
    console.error("Falta GEMINI_API_KEY en el entorno");
    return {
      theme: "Semana de cine recomendada",
      description:
        "Un evento semanal con películas muy bien valoradas para descubrir nuevas historias juntos.",
    };
  }

  // Texto con la info de las candidatas
  const moviesText = candidates
    .map((m) => {
      const yearText = m.year ? ` (${m.year})` : "";
      const overview = m.overview || "";
      return `- ${m.title}${yearText}: ${overview}`;
    })
    .join("\n");

  const prompt = `
Eres el organizador creativo de un cineclub.

Te doy una lista de 3 películas candidatas para la "Semana del Cine":

${moviesText}

TU TAREA:

1. Inventar un TEMA para la semana (por ejemplo: "Semana de giros inesperados", "Viajes que te cambian la vida", "Risas y corazones").
2. Escribir una DESCRIPCIÓN del evento en ESPAÑOL, con 5–8 frases, hablando de:
   - qué tienen en común estas películas,
   - qué tipo de experiencia ofrece esta semana,
   - por qué puede gustarle a un grupo de amigos que ve cine juntos,
   - el tono general (emocional, divertido, intenso, reflexivo, etc.).

TONO:

- Cercano, cálido, natural.
- Dirigido a "vosotros" (segunda persona plural).
- NO menciones APIs, ni modelos, ni nada técnico.

FORMATO DE RESPUESTA (OBLIGATORIO):

Devuelve SOLO JSON, sin texto extra, con este formato EXACTO:

{
  "theme": "Nombre del tema",
  "description": "Texto largo en español..."
}
`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      }),
    }
  );

  if (!resp.ok) {
    console.error("Gemini status:", resp.status);
    const body = await resp.text();
    console.error("Gemini body:", body);

    return {
      theme: "Semana de cine recomendada",
      description:
        "Un evento semanal con películas muy bien valoradas para descubrir nuevas historias juntos.",
    };
  }

  const data: any = await resp.json();
  const candidatesOut = data.candidates ?? [];
  const parts = candidatesOut[0]?.content?.parts ?? [];
  const textPart: string = parts.map((p: any) => p.text || "").join("\n");

  let theme = "Semana de cine recomendada";
  let description =
    "Un evento semanal con películas muy bien valoradas para descubrir nuevas historias juntos.";

  try {
    const parsed = JSON.parse(textPart);
    if (parsed.theme && parsed.description) {
      theme = parsed.theme.toString();
      description = parsed.description.toString();
    } else {
      console.error("JSON de Gemini sin claves theme/description:", textPart);
    }
  } catch (e) {
    console.error("Error parseando JSON de Gemini:", e, textPart);
  }

  return { theme, description };
}

// ---------- Handler principal ----------

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Método no permitido" });
    }

    // 1) Sacamos 3 pelis top de TMDB como candidatas
    const topMovies = await fetchTopRatedFromTmdb(10);
    if (!topMovies.length) {
      return res.status(500).json({
        error: "No se han podido obtener películas de TMDB.",
      });
    }

    const candidates = topMovies.slice(0, 3);

    // 2) Pedimos a Gemini un tema y descripción para este pack
    const { theme, description } = await generateEventWithGemini(candidates);

    // 3) Fechas del evento (una semana a partir de hoy)
    const now = new Date();
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    const end = new Date(now.getTime() + oneWeekMs);

    const event: WeeklyEventDto = {
      id: `week-${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
      theme,
      description,
      startVoteDate: now.toISOString(),
      endVoteDate: end.toISOString(),
      candidates: candidates.map((c) => ({
        tmdbId: c.tmdbId,
        title: c.title,
        year: c.year,
      })),
    };

    return res.status(200).json({ event });
  } catch (e: any) {
    console.error("Error general en /api/weekly-event-generate:", e);
    return res.status(500).json({
      error: "Error interno en el servidor.",
      info: e?.message ?? "unknown",
    });
  }
}
