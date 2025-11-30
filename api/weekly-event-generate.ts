export default async function handler(req: any, res: any) {


// pages/api/weekly-event-generate.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "../../lib/firebaseAdmin";
import { fetchTopFromAppRanking, AppTopMovie } from "../../helpers/fetchTopFromAppRanking";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

type WeeklyEventCandidate = {
  tmdbId: number;
  title: string;
  year?: number;
};

export type WeeklyEventDto = {
  id: string;
  theme: string;
  shortDescription: string;
  longArticle: string;
  imagePrompt?: string;
  imageUrl?: string | null;
  startVoteDate: string;
  endVoteDate: string;
  startWatchDate: string;
  endWatchDate: string;
  startForumDate: string;
  endForumDate: string;
  phase: "VOTING" | "WATCHING" | "FORUM" | "FINISHED";
  candidates: WeeklyEventCandidate[];
};

type ApiResponse = { error?: string; info?: string } | WeeklyEventDto;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  try {
    // ⚠️ Este endpoint lo llamará SOLO el CRON de Vercel,
    // puedes protegerlo con un token en cabecera si quieres.
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Método no permitido" });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Gemini no está configurado (falta GEMINI_API_KEY).",
      });
    }

    // 1) Leemos el top 80 de TU ranking
    const topMovies: AppTopMovie[] = await fetchTopFromAppRanking(80);

    if (!topMovies.length) {
      return res.status(400).json({
        error: "No hay datos suficientes en el ranking global.",
      });
    }

    const rankingText = topMovies
      .map((m, idx) => {
        const pos = idx + 1;
        const rating = m.avgRatingGlobal.toFixed(1);
        const year = m.year ?? "?";
        return `${pos}. ${m.title} (${year}) → nota media grupo ${rating}/10 (${m.numRatings} votos)`;
      })
      .join("\n");

    const seenTitlesLower = new Set(
      topMovies.map((m) => m.title.toLowerCase().trim())
    );

    // 2) Prompt para Gemini (tema + artículo + 3 pelis NO incluidas en ranking)
    const systemPrompt = `
Eres programador y articulista de un cineclub muy especial.

Tienes delante la lista de 80 películas mejor valoradas por la comunidad.
Eso te dice mucho sobre SUS GUSTOS REALES como grupo.

TU MISIÓN:

1) Analizar qué tipo de cine le gusta a esta comunidad en conjunto:
   - ¿Valoran más el guion, la emoción, el ritmo, los finales duros, el humor…?
   - ¿Hay tendencias claras? (cine de autor, hollywood clásico, thrillers, etc.)

2) A partir de eso, definir una TEMÁTICA ORIGINAL para la "Semana de Cineclub":
   - Ejemplos (NO los uses tal cual, crea otros): 
     "Semana de heridas invisibles", 
     "Semana de amores raros pero honestos",
     "Semana de mundos que se derrumban",
     "Semana de comedias que te curan un poco por dentro", etc.

3) Escribir DOS textos sobre esa temática:
   - shortDescription: 3–5 frases máximo, tono cercano, que sirva como introducción corta.
   - longArticle: un ARTÍCULO extenso tipo revista de cine, en español:
     • habla de cómo ha tratado el cine ese tema a lo largo del tiempo,
     • menciona ejemplos de películas famosas (aunque no sean las del ranking),
     • cuenta curiosidades, anécdotas, pequeños datos históricos,
     • conecta el tema con la vida real del espectador,
     • debe ser inspirador y muy agradable de leer.
     • extensión orientativa: entre 800 y 1500 palabras.

4) Proponer 3 PELÍCULAS CANDIDATAS para la semana que:
   - NO aparezcan en la lista de 80 pelis del ranking que te paso.
   - Encajen MUY bien con la temática.
   - No sean las típicas ultra-mainstream del TOP histórico (busca cosas con alma, aunque sean conocidas).
   - Para cada una:
     • "title": título de la película,
     • "year": año aproximado,
     • "reason": 3–6 frases explicando por qué encaja tan bien en el tema y por qué podría gustar a ESTA comunidad.

5) Crear también un "imagePrompt":
   - descripción en inglés para ilustrar el tema de la semana en una sola imagen cinematográfica
     (sin texto escrito dentro de la imagen).
   - Piensa en algo que pueda usarse en un póster: composición, luz, atmósfera, etc.

FORMATO DE RESPUESTA (OBLIGATORIO):

{
  "theme": "Nombre corto del evento",
  "shortDescription": "Texto breve...",
  "longArticle": "Artículo largo en español...",
  "imagePrompt": "Prompt en inglés para generar una imagen IA...",
  "candidates": [
    { "title": "Nombre peli 1", "year": 2012, "reason": "Texto en español..." },
    { "title": "Nombre peli 2", "year": 1998, "reason": "Texto en español..." },
    { "title": "Nombre peli 3", "year": 2005, "reason": "Texto en español..." }
  ]
}

No devuelvas nada fuera de este JSON.
`;

    const userPrompt = `
Estas son las 80 películas más valoradas por la comunidad (ya las han visto y NO deben ser candidatas):

${rankingText}

Recuerda:
- Usa estos datos como "huella de gustos" de la comunidad.
- No repitas ninguna de estas películas como candidata de la semana.
`;

    const promptText = systemPrompt + "\n\n" + userPrompt;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptText }] }],
        }),
      }
    );

    if (!geminiResponse.ok) {
      const textErr = await geminiResponse.text();
      console.error("Gemini error:", geminiResponse.status, textErr);
      return res.status(500).json({
        error: "Error llamando a Gemini para generar el evento.",
        info: textErr,
      });
    }

    const geminiJson: any = await geminiResponse.json();
    const parts = geminiJson.candidates?.[0]?.content?.parts ?? [];
    const textPart: string = parts.map((p: any) => p.text || "").join("\n");

    let parsed: {
      theme?: string;
      shortDescription?: string;
      longArticle?: string;
      imagePrompt?: string;
      candidates?: { title: string; year?: number | string; reason?: string }[];
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

    const theme = (parsed.theme || "").toString().trim();
    const shortDescription = (parsed.shortDescription || "").toString().trim();
    const longArticle = (parsed.longArticle || "").toString().trim();
    const imagePrompt = (parsed.imagePrompt || "").toString().trim();
    const rawCandidates = Array.isArray(parsed.candidates)
      ? parsed.candidates
      : [];

    // Filtrar candidatos: título + reason y no repetir títulos del ranking
    const cleanCandidates = rawCandidates.filter((c) => {
      if (!c || !c.title || !c.reason) return false;
      const titleLower = c.title.toString().toLowerCase().trim();
      if (!titleLower) return false;
      if (seenTitlesLower.has(titleLower)) return false;
      return true;
    });

    if (!theme || !shortDescription || !longArticle || !cleanCandidates.length) {
      console.error("Gemini devolvió datos incompletos:", parsed);
      return res.status(500).json({
        error: "Gemini devolvió un evento incompleto.",
      });
    }

    // En este punto asumimos que ya tienes los tmdbId de esas pelis
    // (por simplicidad, aquí NO busco en TMDB; podrías añadir búsqueda si quieres).
    // Vamos a quedarnos con las 3 primeras y PONER tmdbId = 0 para que la app
    // no rompa; más adelante amplías esto con búsqueda en TMDB si quieres.
    const candidates = cleanCandidates.slice(0, 3).map((c) => {
      const yearNum =
        typeof c.year === "number"
          ? c.year
          : typeof c.year === "string"
          ? parseInt(c.year, 10)
          : undefined;

      return {
        tmdbId: 0, // TODO: aquí podrías buscar en TMDB por título+año para rellenar
        title: c.title.toString(),
        year: yearNum,
      };
    });

    // Fechas de fases
    const today = new Date();
    const startVote = today;
    const endVote = new Date(today.getTime());
    endVote.setDate(endVote.getDate() + 6); // 7 días de votación

    const startWatch = new Date(endVote.getTime());
    startWatch.setDate(startWatch.getDate() + 1);
    const endWatch = new Date(startWatch.getTime());
    endWatch.setDate(endWatch.getDate() + 7);

    const startForum = new Date(endWatch.getTime());
    startForum.setDate(startForum.getDate() + 1);
    const endForum = new Date(startForum.getTime());
    endForum.setDate(endForum.getDate() + 7);

    function toIsoDate(d: Date): string {
      return d.toISOString().slice(0, 10);
    }

    const startVoteDate = toIsoDate(startVote);
    const endVoteDate = toIsoDate(endVote);
    const startWatchDate = toIsoDate(startWatch);
    const endWatchDate = toIsoDate(endWatch);
    const startForumDate = toIsoDate(startForum);
    const endForumDate = toIsoDate(endForum);

    const eventId = startVoteDate;

    const event: WeeklyEventDto = {
      id: eventId,
      theme,
      shortDescription,
      longArticle,
      imagePrompt,
      imageUrl: null,
      startVoteDate,
      endVoteDate,
      startWatchDate,
      endWatchDate,
      startForumDate,
      endForumDate,
      phase: "VOTING",
      candidates,
    };

    // Guardar en Firestore
    await db.collection("weeklyEvents").doc(eventId).set({
      ...event,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json(event);
  } catch (e: any) {
    console.error("Error general en weekly-event-generate:", e);
    return res.status(500).json({
      error: "Error interno generando el evento.",
      info: e?.message ?? "unknown",
    });
  }
}
  
}
