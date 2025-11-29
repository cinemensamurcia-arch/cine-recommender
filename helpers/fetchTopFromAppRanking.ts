// helpers/fetchTopFromAppRanking.ts
import { db } from "../lib/firestoreAdmin";

export type AppTopMovie = {
  tmdbId: number;
  title: string;
  year?: number;
  avgRatingGlobal: number;
  numRatings: number;
};

export async function fetchTopFromAppRanking(limit: number): Promise<AppTopMovie[]> {
  const snap = await db
    .collection("moviesRanking")
    .orderBy("avgRatingGlobal", "desc")
    .limit(limit)
    .get();

  const list: AppTopMovie[] = [];

  snap.forEach((doc) => {
    const data = doc.data();
    const tmdbId = data.tmdbId;
    const title = data.title || `Película ${tmdbId}`;
    const year = data.year;
    const avgRatingGlobal = data.avgRatingGlobal ?? 0;
    const numRatings = data.numRatings ?? 0;

    if (typeof tmdbId !== "number") return;

    list.push({
      tmdbId,
      title,
      year,
      avgRatingGlobal,
      numRatings,
    });
  });

  return list;
}
