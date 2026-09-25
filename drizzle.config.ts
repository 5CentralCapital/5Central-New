// The 5Central Ops reviewed SQL chain is the sole schema authority. A second Drizzle
// push/generation path would silently diverge from its frozen checksums.
throw new Error(
  "Independent Drizzle schema changes are disabled. Verify the company migration registry and render the existing 5Central Ops reviewed SQL artifacts instead.",
);

export default {};
