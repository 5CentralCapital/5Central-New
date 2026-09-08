function safeCsvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: unknown[]): string {
  if (rows.length === 0) return "";
  const records = rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  const keys = Array.from(new Set(records.flatMap((row) => Object.keys(row))));
  return [keys.join(","), ...records.map((row) => keys.map((key) => safeCsvCell(row[key])).join(","))].join("\n");
}
