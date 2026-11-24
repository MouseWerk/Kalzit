/**
 * The accounts and organizations whose sidebar data was already loaded before a first frame
 * (src/shell/primeShell.ts): later page changes do not wait for it again. Forgotten with the
 * account's other data at sign-out (`forgetAccountData`), so the next sign-in primes again.
 */
const primed = new Set<string>();

/** Marks `userId` in `orgId` as primed; false when it already was. */
export function markPrimed(userId: string, orgId: string): boolean {
  const key = `${userId}\u0000${orgId}`;
  if (primed.has(key)) {
    return false;
  }
  primed.add(key);
  return true;
}

export function forgetPrimed(): void {
  primed.clear();
}
