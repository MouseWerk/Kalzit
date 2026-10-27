import { useEffect, useState } from "react";

/**
 * `value` once it stayed the same for `ms`, compared as JSON: typing a number or switching a
 * choice back and forth asks the server once, for the value the person settled on.
 */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  const key = JSON.stringify(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the value is compared by its JSON
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return settled;
}
