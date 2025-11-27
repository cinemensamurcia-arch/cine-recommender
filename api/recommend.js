// api/recommend.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const { uid, lastRatings, userPrompt, mode } = req.body || {};

  if (!uid || !Array.isArray(lastRatings)) {
    return res.status(400).json({
      error: "uid y lastRatings son obligatorios"
    });
  }

  const effectiveMode = mode === "prompt" ? "prompt" : "auto";

  const basePrompt = `
Eres un recomendador de cine para un grupo privado llamado "Cine Mensa Murcia".
Tienes estas valoraciones recientes del usuario (cada objeto incluye título y notas):

${JSON.stringify(lastRatings, null, 2)}

Tu tarea:
- Generar una lista de 3 a 6 recomendaciones de películas.
- Devuelve SOLO un JSON válido con este formato:

[
  {
    "tmdbId": 123,
    "title": "Título en español",
    "reason": "Explicación clara, breve y cercana de por qué se la recomiendo."
  }
]

Reglas:
- No incluyas texto extra fuera del JSON.
- No repitas películas que ya aparecen en lastRatings (usa sus tmdbId para evitar duplicados).
- Si mode = "auto", usa SOLO su historial de gustos.
- Si mode = "prompt", además ten MUY en cuenta esta petición del usuario:
  "${userPrompt || ""}".
- Evita recomendar pelis extremadamente difíciles o experimentales a menos que su historial lo sugiera.
`;

  try {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      return res.status(500).json({
        error: "Falta GEMINI_API_KEY en el servidor"
      });
    }

    // Llamada a Gemini (modelo Flash, barato/gratis)
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
        geminiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: basePrompt }]
            }
          ]
        })
      }
    );

    const aiJson = await response.json();

    // Sacar el texto de la respuesta
    const text =
      aiJson?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]";

    let recommendations = [];
    try {
      recommendations = JSON.parse(text);
      if (!Array.isArray(recommendations)) {
        recommendations = [];
      }
    } catch (e) {
      console.error("Error parseando JSON de Gemini:", e, text);
      recommendations = [];
    }

    return res.status(200).json({ recommendations });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Error interno en la recomendación"
    });
  }
}
