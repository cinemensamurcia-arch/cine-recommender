// pages/api/weekly-event-generate.ts
import type { NextApiRequest, NextApiResponse } from "next";

type WeeklyCandidate = {
  tmdbId: number;
  title: string;
  year?: number;
};

type WeeklyEvent = {
  id: string;                // p.ej. "2025-W48"
  theme: string;             // "Semana de giros inesperados"
  description: string;       // texto para mostrar en la app
  startVoteDate: string;     // ISO string
  endVoteDate: string;       // ISO string
  candidates: WeeklyCandidate[];
};

type ApiResponse =
  | { error: string; info?: string }
  | { event: WeeklyEvent; info?: string };

// Utilidad para obtener la “semana del año”
function getWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((+date - +yearStart) / 86400000 + 1) / 7);
}

// Temáticas base (por ahora fijas; luego las podrá escribir Gemini)
const THEMES = [
  {
    theme: "Semana de giros inesperados",
    description:
      "Esta semana buscamos películas que te hagan decir: '¿Pero qué acabo de ver?'. Historias que parecen ir por un camino… y de repente giran en seco.",
  },
  {
    theme: "Semana de terror psicológico",
    description:
      "No hace falta sangre para pasar miedo. Esta semana nos vamos al terror que se mete en la cabeza: atmósferas raras, tensión y ese mal rollo que se queda pegado.",
  },
  {
    theme: "Semana de comedia con corazón",
    description:
      "Películas para reír, pero también para sentir. Historias que te sacan una sonrisa y, al mismo tiempo, te tocan algo por dentro.",
  },
  {
    theme: "Semana de ciencia ficción existencial",
    description:
      "Viajes espaciales, futuros raros y preguntas sobre quiénes somos y hacia dónde vamos. Sci-fi que no solo entretiene, también hace pensar.",
  },
];

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Método no permitido" });
    }

    // 📅 Generamos un ID de evento por semana
    const now = new Date();
    const year = now.getFullYear();
    const week = getWeekNumber(now);
    const eventId = `${year}-W${week}`;

    // Elegimos una temática “rotando”
    const themeIndex = week % THEMES.length;
    const chosenTheme = THEMES[themeIndex];

    // 🕒 Ventana de votación: de hoy a +6 días
    const startVoteDate = new Date(now);
    const endVoteDate = new Date(now);
    endVoteDate.setDate(endVoteDate.getDate() + 6);

    // 🔹 POR AHORA candidatos fijos de ejemplo
    // Luego esto lo puedes sustituir por:
    // - top global filtrado
    // - o listado generado por Gemini y mapeado a tmdbId con TMDB
    const candidates: WeeklyCandidate[] = [
      { tmdbId: 238, title: "El padrino", year: 1972 },
      { tmdbId: 680, title: "Pulp Fiction", year: 1994 },
      { tmdbId: 27205, title: "Origen", year: 2010 },
    ];

    const event: WeeklyEvent = {
      id: eventId,
      theme: chosenTheme.theme,
      description: chosenTheme.description,
      startVoteDate: startVoteDate.toISOString(),
      endVoteDate: endVoteDate.toISOString(),
      candidates,
    };

    return res.status(200).json({
      event,
      info: "Evento semanal generado de forma estática (sin Gemini aún).",
    });
  } catch (e: any) {
    console.error("Error general en /api/weekly-event-generate:", e);
    return res.status(500).json({
      error: "Error interno en el servidor.",
      info: e?.message ?? "unknown",
    });
  }
}

