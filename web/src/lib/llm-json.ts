/**
 * Tolerant JSON parsing for small local LLMs. Tries, in order: the raw text, a fenced block, the
 * first balanced object, and repaired variants of each (raw control characters inside strings,
 * unescaped inner quotes, output truncated mid-string). Throws when nothing parses.
 */
export function parseLlmJson<T>(raw: string): T {
  const text = raw.trim();
  const candidates: string[] = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const balanced = firstBalancedObject(text);
  if (balanced) candidates.push(balanced);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    for (const variant of [candidate, escapeControlCharsInStrings(candidate), repairQuotes(candidate), closeTruncated(repairQuotes(candidate))]) {
      try {
        return JSON.parse(variant) as T;
      } catch {
        /* next variant */
      }
    }
  }
  throw new Error("El modelo devolvió un JSON inválido");
}

/** The first `{ … }` with balanced braces, ignoring braces inside string literals. */
function firstBalancedObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/** Walks the text and escapes newlines/tabs that appear inside string literals. */
function escapeControlCharsInStrings(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
    } else {
      out += ch;
      if (ch === '"') inString = true;
    }
  }
  return out;
}

/**
 * Escapes double quotes that appear *inside* string values (e.g. lyrics with "quoted" words) and
 * control characters. A closing quote is one followed by a structural character (`,` `}` `]` `:`);
 * any other quote inside a string is treated as literal.
 */
function repairQuotes(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === "\\") {
      out += ch;
      escaped = true;
    } else if (ch === '"') {
      const rest = s.slice(i + 1);
      if (/^\s*[,}\]:]/.test(rest) || rest.trim() === "") {
        out += ch;
        inString = false;
      } else {
        out += '\\"';
      }
    } else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

/** Output cut mid-string (token limit): close the open string, drop a dangling key, close the braces. */
function closeTruncated(s: string): string {
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  let fixed = s.replace(/\\$/, "");
  if (inString) fixed += '"';
  fixed = fixed.replace(/,\s*$/, "").replace(/"\s*:\s*$/, '": ""');
  return fixed + "}".repeat(Math.max(0, depth));
}
