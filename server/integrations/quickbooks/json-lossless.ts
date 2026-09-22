/**
 * Parse provider JSON without converting JSON number lexemes through a
 * JavaScript Number. QBO monetary values can exceed Number's exact integer
 * range even when the JSON document is otherwise valid. Numeric tokens are
 * returned as their original decimal text; callers that need a count or ID
 * validate and convert that text explicitly.
 */
export function parseJsonLosslessNumbers(text: string): unknown {
  let index = 0;

  const fail = (): never => { throw new SyntaxError("Invalid JSON response"); };
  const whitespace = (): void => { while (index < text.length && /[\t\n\r ]/.test(text[index] ?? "")) index += 1; };

  function stringValue(): string {
    if (text[index] !== '"') return fail();
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index++];
      if (escaped) {
        escaped = false;
        if (character === "u") {
          if (index + 4 > text.length || !/^[0-9A-Fa-f]{4}$/.test(text.slice(index, index + 4))) return fail();
          index += 4;
        } else if (!/["\\/bfnrt]/.test(character ?? "")) return fail();
        continue;
      }
      if (character === "\\") { escaped = true; continue; }
      if (character === '"') {
        try { return JSON.parse(text.slice(start, index)) as string; } catch { return fail(); }
      }
      if (character < " ") return fail();
    }
    return fail();
  }

  function numberValue(): string {
    const start = index;
    if (text[index] === "-") index += 1;
    if (text[index] === "0") index += 1;
    else {
      if (!/[1-9]/.test(text[index] ?? "")) return fail();
      while (/\d/.test(text[index] ?? "")) index += 1;
    }
    if (text[index] === ".") {
      index += 1;
      if (!/\d/.test(text[index] ?? "")) return fail();
      while (/\d/.test(text[index] ?? "")) index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (!/\d/.test(text[index] ?? "")) return fail();
      while (/\d/.test(text[index] ?? "")) index += 1;
    }
    return text.slice(start, index);
  }

  function value(): unknown {
    whitespace();
    const character = text[index];
    if (character === '"') return stringValue();
    if (character === "{") {
      index += 1;
      const result: Record<string, unknown> = {};
      whitespace();
      if (text[index] === "}") { index += 1; return result; }
      while (true) {
        whitespace();
        const key = stringValue();
        whitespace();
        if (text[index++] !== ":") return fail();
        result[key] = value();
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") return fail();
      }
    }
    if (character === "[") {
      index += 1;
      const result: unknown[] = [];
      whitespace();
      if (text[index] === "]") { index += 1; return result; }
      while (true) {
        result.push(value());
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "]") return result;
        if (delimiter !== ",") return fail();
      }
    }
    if (text.startsWith("true", index)) { index += 4; return true; }
    if (text.startsWith("false", index)) { index += 5; return false; }
    if (text.startsWith("null", index)) { index += 4; return null; }
    if (character === "-" || /\d/.test(character ?? "")) return numberValue();
    return fail();
  }

  const result = value();
  whitespace();
  if (index !== text.length) return fail();
  return result;
}
