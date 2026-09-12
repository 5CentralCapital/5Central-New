import { useEffect, useState } from "react";

/** Delay search reads while keeping clearing and all other filter changes immediate. */
export function useReportSearch(search: string) {
  const rawSearch = search.trim();
  const [settledSearch, setSettledSearch] = useState("");
  useEffect(() => {
    if (!rawSearch) {
      setSettledSearch("");
      return;
    }
    const timer = setTimeout(() => setSettledSearch(rawSearch), 300);
    return () => clearTimeout(timer);
  }, [rawSearch]);
  const debouncedSearch = rawSearch ? settledSearch : "";
  return { debouncedSearch, searchPending: rawSearch !== debouncedSearch };
}
