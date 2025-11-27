const userPrompt = `
Usuario con uid=${uid}.

Estas son algunas de sus valoraciones (para que veas qué le gusta y qué valora):

${userMoviesForPrompt}

Donde:
- "overall" es la nota general.
- "guion", "direccion", "actuacion", "bso" y "disfrute" indican qué aspectos
  valora más en cada película.

Estas son las películas CANDIDATAS (todas recomendadas por TMDB a partir de pelis que le gustaron):

${candidatesForPrompt}

INSTRUCCIONES ESPECÍFICAS PARA ESTE USUARIO:

- Elige SOLO entre esas CANDIDATAS.
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

Devuélveme hasta ${max} recomendaciones con este formato EXACTO, sin texto adicional:

{
  "recommendations": [
    { "tmdbId": 123, "title": "Nombre", "reason": "Texto en español..." }
  ]
}
`;



