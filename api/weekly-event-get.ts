// pages/api/weekly-event-get.ts

import { db, admin } from "../lib/firebaseAdmin";
import { WeeklyEventDto } from "./weekly-event-generate";

type ApiResponse = { error: string; info?: string } | WeeklyEventDto;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Método no permitido" });
    }

    const snap = await db
      .collection("weeklyEvents")
      .orderBy("startVoteDate", "desc")
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: "No hay evento semanal disponible." });
    }

    const doc = snap.docs[0];
    const data = doc.data() as WeeklyEventDto;
    return res.status(200).json(data);
  } catch (e: any) {
    console.error("Error en weekly-event-get:", e);
    return res.status(500).json({
      error: "Error interno obteniendo el evento.",
      info: e?.message ?? "unknown",
    });
  }
}
