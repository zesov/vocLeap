import { describe, expect, test } from "bun:test";
import { createRemoteData } from "../../../lib/data/remote";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("remote data", () => {
  test("getDueReviews calls the right action", async () => {
    let seen = "";
    const api = createRemoteData((async (input: RequestInfo | URL) => {
      seen = String(input);
      return json([]);
    }) as typeof fetch);

    await api.getDueReviews(50);
    expect(seen).toBe("/api/reviews?action=due&limit=50");
  });

  test("getStats reads the stats action", async () => {
    const api = createRemoteData((async () =>
      json({ due: 3, total: 10, newWords: 2 })) as unknown as typeof fetch);
    expect(await api.getStats()).toEqual({ due: 3, total: 10, newWords: 2 });
  });

  test("getWords forwards limit, offset and sort", async () => {
    let seen = "";
    const api = createRemoteData((async (input: RequestInfo | URL) => {
      seen = String(input);
      return json({ words: [], total: 0, limit: 30, offset: 0, sort: "alpha_asc", hasMore: false });
    }) as typeof fetch);

    await api.getWords({ limit: 30, offset: 0, sort: "alpha_asc" });
    expect(seen).toBe("/api/words?limit=30&offset=0&sort=alpha_asc");
  });

  test("submitReview posts wordId, rating and timezone", async () => {
    let body: Record<string, unknown> = {};
    const api = createRemoteData((async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return json({ wordId: 7 });
    }) as typeof fetch);

    await api.submitReview({ wordId: 7, rating: "good" });
    expect(body).toMatchObject({ wordId: 7, rating: "good" });
    expect(typeof body.timezone).toBe("string");
  });

  test("surfaces API errors with status", async () => {
    const api = createRemoteData((async () =>
      json({ error: "Word not found" }, 404)) as unknown as typeof fetch);
    await expect(api.getWordHistory(9)).rejects.toThrow("Word not found");
  });
});
