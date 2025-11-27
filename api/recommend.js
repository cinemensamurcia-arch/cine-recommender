import * as functions from "firebase-functions";
import fetch from "node-fetch"; // si estás en Node < 18

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

type IncomingRating = {
  tmdbId: number;
  overall: number;
  guion: number;
  direccion: number;
  actuacion: number;
  bso: number;
  disfrute: number;
  title?: string; // opcional
  year?: string;  // opcional
};

type AiRecommendation = {
  tmdbId?: number;
  title: string;
  reason: string;
};

export const recommendMovies = functions.https.onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Método no permitido" });
    }

    const uid = req.body.uid as string | undefined;
    const ratings = req.body.ratings as IncomingRating[] | undefined;
    const maxItems = (req.body.maxItems as number | undefined) ?? 15;

    if (!uid || !ratings || !Array.isArray(ratings)) {
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

    // 1) Fallback local: ordenamos por nota global y usamos eso
    const sortedByOverall = [...ratings].sort(
      (a, b) => b.overall - a.overall
    );

    const localFallback: AiRecommendation[] = sortedByOverall
      .slice(0, Math.min(maxItems, sortedByOverall.length))
      .map((r) => ({
        tmdbId: r.tmdbId,
        title: r.title ?? `Película ${r.tmdbId}`,
        reason: `Te la recomiendo porque la valoraste con un ${r.overall}/10.`,
      }));

    // Si no hay API key de Gemini, devolvemos directamente el fallback local
    if (!GEMINI_API_KEY) {
      return res.status(200).json({
        recommendations: localFallback,
        info: "Devueltas solo recomendaciones locales (sin IA).",
      });
    }

    // 2) Preparamos prompt para Gemini. NO hace falta que venga el title.
    const userMoviesForPrompt = ratings
      .slice(0, 80)
      .map((r) => {
        const namePart = r.title
          ? `${r.title} (${r.year ?? "?"})`
          : `Película con tmdbId=${r.tmdbId}`;
        return `${namePart}: general ${r.overall}/10, guion ${r.guion}/10, dirección ${r.direccion}/10, actuación ${r.actuacion}/10, BSO ${r.bso}/10, disfrute ${r.disfrute}/10`;
      })
      .join("\n");

    const systemPrompt = `
Eres un recomendador de cine para un grupo de amigos.
Tienes que recomendar películas basándote en las valoraciones del usuario.

Responde SIEMPRE en JSON puro con este formato EXACTO:

{
  "recommendations": [
    { "tmdbId": 13, "title": "Forrest Gump", "reason": "..." }
  ]
}
`;

    const userPrompt = `
Usuario con uid=${uid}

Estas son algunas de sus valoraciones:

${userMoviesForPrompt}

Devuélveme hasta ${maxItems} recomendaciones variadas, con "tmdbId" si lo conoces, "title" y "reason" clara y breve.
Si dudas, sugiere también películas similares a las mejor valoradas por el usuario.
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
        // usamos fallback
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

        finalRecs = arr.filter(
          (r) => r && r.title && r.title.toString().trim().length > 0
        );

        if (!finalRecs.length) {
          finalRecs = localFallback;
        }
      }
    } catch (e) {
      console.error("Error al llamar a Gemini:", e);
      finalRecs = localFallback;
    }

    return res.status(200).json({
      recommendations: finalRecs.slice(0, maxItems),
      info: "Recomendaciones devueltas (IA + fallback).",
    });
  } catch (e) {
    console.error("Error general en recommendMovies:", e);
    return res.status(500).json({ error: "Error interno en el servidor." });
  }
});

