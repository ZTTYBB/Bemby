/** Value of a proxy pick meaning "draw one from the pool, per run". */
export const PROXY_RANDOM = "random";

/**
 * A picked exit as the API takes it: the pick itself, and the pool only when the pick is a
 * draw. An empty pool is left off, since an absent pool already means the whole proxy list.
 */
export function proxyFields(
  proxyId: string,
  pool: string[],
): { proxyId?: string; proxyPool?: string[] } {
  if (!proxyId) return {};
  return {
    proxyId,
    ...(proxyId === PROXY_RANDOM && pool.length ? { proxyPool: [...pool] } : {}),
  };
}
