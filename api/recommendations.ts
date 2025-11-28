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
    const sortedByOverall = [...ratings].sort((a, b) => b.overall - a.overall);

    // IDs que el usuario ya ha visto (para filtros y fallbacks)
    const seenIds = new Set<number>(ratings.map((r) => r.tmdbId));

    // Conjunto de títulos vistos (para que Gemini no repita)
    const seenTitlesLower = new Set(
      ratings
        .map((r) => r.title?.toLowerCase().trim())
        .filter((t): t is string => !!t)
    );

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

    // ------------------------------
    //  Si no hay GEMINI_API_KEY → error claro
    // ------------------------------
    if (!GEMINI_API_KEY) {
      console.error("Falta GEMINI_API_KEY en el entorno de Vercel");
      return res.status(500).json({
        error:
          "Gemini no está configur






