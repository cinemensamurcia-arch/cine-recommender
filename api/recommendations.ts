// pages/api/recommendations.ts
import type { NextApiRequest, NextApiResponse } from "next";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Lo que tú mandas desde la app
type IncomingRating = {
  tmdbId: number;
  overall: number;
  guion: number;
  direccion: number;
  actuacion: number;
  bso: number;
  disfrute: number;
  title?: string; // ahora SÍ esperamos que lleguen
  year?: string;
};

// Lo que devolverá el endpoint a tu app
export type AiRecommendation = {
  tmdbId?: number;
  title: string;
  reason: string;
};

type ApiResponse =
  | { error: string; info?: string }
  | { recommendations: AiRecommendation[]; info?: string };

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

    // 🔹 Conjunto de títulos ya vistos (para evitar recomendar lo mismo cuando usemos IA)
    const ratedTitlesSet = new Set(
      ratings
        .map((r) => (r.title ?? "").toLowerCase().trim())
        .filter((t) => t.length > 0)
    );

    // 1) Fallback local: ordenar por nota global y usar eso si la IA falla
    const sortedByOverall = [...ratings].sort(
      (a, b) => b.overall - a.overall
    );

    const localFallback: AiRecommendation[] = sortedByOverall
      .slice(0, Math.min(max, sortedByOverall.length))
      .map((r) => ({
        tmdbId: r.tmdbId,
        title: r.title ?? `Película ${r.tmdbId}`,
        reason: `Te la recomiendo porque la valoraste con un ${r.overall}/10 (guion ${r.guion}/10, disfrute ${r.disfrute}/10).`,
      }));

    // Si NO hay API key, devolvemos únicamente el fallback local (pero sin error 500)
    if (!GEMINI_API_KEY) {
      return res.status(200).json({
        recommendations: localFallback,
        info: "Devueltas solo recomendaciones locales (sin IA, falta GEMINI_API_KEY).",
      });
    }

    // 2) Preparamos prompt para Gemini
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

    // 🧠 System prompt: rol del modelo + formato JSON estricto
    const systemPrompt = `
Eres un recomendador de cine para un grupo de amigos.
Tu objetivo es recomendar películas NUEVAS al usuario basándote en lo que ya ha visto y valorado.

Tienes que tener en cuenta:
- Las valoraciones generales, pero especialmente:
  - "disfrute" (qué tanto disfrutó la película).
  - "guion" (calidad de la historia).
- Otros campos (dirección, actuación, BSO) también ayudan a reconocer patrones de gustos.

Muy importante:
- Las películas que ya aparecen en la lista de valoraciones del usuario SON PELÍCULAS YA VISTAS.
- No vuelvas a recomendarlas como si fueran nuevas.
- Recomienda OTRAS películas distintas, que encajen con sus gustos.
- Si quieres, puedes mencionar la relación con las ya vistas en la explicación ("reason"), pero NO las repitas como recomendación principal.

Responde SIEMPRE en JSON puro con este formato EXACTO (sin texto extra):

{
  "recommendations": [
    { "tmdbId": 13, "title": "Forrest Gump", "reason": "..." }
  ]
}
`;

    // 🧠 User prompt: datos concretos del usuario
    const userPrompt = `
Usuario con uid=${uid}

Estas son algunas de sus valoraciones (películas YA VISTAS):

${userMoviesForPrompt}

Listado breve de títulos ya vistos:
${seenTitlesList || "(sin títulos conocidos)"}

Tarea:
- Devuélveme hasta ${max} recomendaciones VARIADAS de películas que NO estén en esa lista de ya vistas.
- Ten MUY en cuenta sobre todo el "disfrute" y el "guion" para saber qué tipo de historias le gustan.
- En "reason" explica brevemente por qué se la recomiendas, mencionando si se parece en tono, tipo de guion, ritmo o sensaciones a alguna de las pelis mejor valoradas.
- Si conoces el "tmdbId" de la película, inclúyelo. Si no lo conoces, puedes omitirlo o poner null.
- No añadas nada fuera del JSON.
`;

    let finalRecs: AiRecommendation[] = [];

    try {
      // Llamada a Gemini
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

        // Aún así respondemos 200 con el fallback, no 500
        finalRecs = localFallback;
      } else {
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

        // 🔍 Filtramos recomendaciones sin título
        let cleaned = arr.filter(
          (r) => r && r.title && r.title.toString().trim().length > 0
        );

        // 🔍 EXTRA: filtramos películas que ya están en sus valoraciones (por título, insensible a mayúsculas)
        cleaned = cleaned.filter((r) => {
          const t = r.title.toString().toLowerCase().trim();
          if (!t) return false;
          return !ratedTitlesSet.has(t);
        });

        finalRecs = cleaned;

        // Si la IA no da nada útil, usamos fallback local
        if (!finalRecs.length) {
          finalRecs = localFallback;
        }
      }
    } catch (e) {
      console.error("Error al llamar a Gemini:", e);
      finalRecs = localFallback;
    }

    return res.status(200).json({
      recommendations: finalRecs.slice(0, max),
      info: "Recomendaciones devueltas (IA + fallback).",
    });
  } catch (e: any) {
    console.error("Error general en /api/recommendations:", e);
    // Última red de seguridad
    return res.status(500).json({
      error: "Error interno en el servidor.",
      info: e?.message ?? "unknown",
    });
  }
}

