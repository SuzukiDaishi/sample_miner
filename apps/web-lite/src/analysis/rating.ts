/**
 * keep/discard 判定 (docs 08 §3.4 D-2) の並び替えヘルパ。
 * 純関数として切り出して vitest 対象にする。
 */
export type UserRating = "keep" | "discard" | undefined;

/** keep=0 → 未評価=1 → discard=2。グリッドの第一ソートキー。 */
export function ratingRank(rating: UserRating): number {
  return rating === "keep" ? 0 : rating === "discard" ? 2 : 1;
}

/** rating rank 優先、同 rank 内はキャッチーさ降順。 */
export function compareForGrid(
  a: { rating: UserRating; catchy: number },
  b: { rating: UserRating; catchy: number }
): number {
  return ratingRank(a.rating) - ratingRank(b.rating) || b.catchy - a.catchy;
}
