// Just enough TOML to read Conductor's settings files: tables, dotted table
// names, strings (basic, literal, multi-line), booleans, numbers and arrays
// of those. Not a general parser; anything else on a line is skipped.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export type TomlTable = { [key: string]: TomlValue };

export function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  let i = 0;
  const peek = () => src[i];
  const skipSpace = () => {
    while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  };
  const skipLine = () => {
    while (i < src.length && src[i] !== "\n") i++;
    i++;
  };
  const key = (): string => {
    skipSpace();
    if (peek() === '"' || peek() === "'") return str() as string;
    const start = i;
    while (i < src.length && /[A-Za-z0-9_-]/.test(src[i])) i++;
    return src.slice(start, i);
  };
  const keyPath = (): string[] => {
    const parts = [key()];
    skipSpace();
    while (peek() === ".") {
      i++;
      parts.push(key());
      skipSpace();
    }
    return parts;
  };
  const str = (): string => {
    const q = src[i];
    const triple = src.startsWith(q.repeat(3), i);
    i += triple ? 3 : 1;
    if (triple && src[i] === "\n") i++; // a newline right after """ is dropped
    let out = "";
    while (i < src.length) {
      if (triple ? src.startsWith(q.repeat(3), i) : src[i] === q) {
        i += triple ? 3 : 1;
        return out;
      }
      if (q === '"' && src[i] === "\\") {
        const c = src[i + 1];
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };
        if (c === "u" || c === "U") {
          const len = c === "u" ? 4 : 8;
          out += String.fromCodePoint(parseInt(src.slice(i + 2, i + 2 + len), 16));
          i += 2 + len;
        } else if (c === "\n" && triple) {
          i += 2;
          while (/\s/.test(src[i] ?? "")) i++; // line-ending backslash
        } else {
          out += map[c] ?? c;
          i += 2;
        }
        continue;
      }
      out += src[i++];
    }
    throw new Error("Unterminated string");
  };
  const value = (): TomlValue => {
    skipSpace();
    const c = peek();
    if (c === '"' || c === "'") return str();
    if (c === "[") {
      i++;
      const arr: TomlValue[] = [];
      for (;;) {
        while (/[\s,]/.test(src[i] ?? "")) i++;
        if (src[i] === "#") {
          skipLine();
          continue;
        }
        if (src[i] === "]") {
          i++;
          return arr;
        }
        arr.push(value());
      }
    }
    const start = i;
    while (i < src.length && !/[\s,\]#]/.test(src[i])) i++;
    const raw = src.slice(start, i);
    if (raw === "true" || raw === "false") return raw === "true";
    const n = Number(raw.replace(/_/g, ""));
    return Number.isNaN(n) ? raw : n;
  };
  const tableAt = (path: string[]): TomlTable => {
    let t = root;
    for (const p of path) {
      if (typeof t[p] !== "object" || Array.isArray(t[p])) t[p] = {};
      t = t[p] as TomlTable;
    }
    return t;
  };

  while (i < src.length) {
    skipSpace();
    const c = peek();
    if (c === "\n" || c === "\r") {
      i++;
    } else if (c === "#") {
      skipLine();
    } else if (c === "[") {
      i++;
      const arrayTable = peek() === "[";
      if (arrayTable) i++;
      const path = keyPath();
      skipLine();
      if (arrayTable) {
        const parent = tableAt(path.slice(0, -1));
        const last = path.at(-1)!;
        if (!Array.isArray(parent[last])) parent[last] = [];
        const t: TomlTable = {};
        (parent[last] as TomlValue[]).push(t);
        table = t;
      } else {
        table = tableAt(path);
      }
    } else {
      const path = keyPath();
      skipSpace();
      if (peek() !== "=") {
        skipLine();
        continue;
      }
      i++;
      const v = value();
      let t = table;
      for (const p of path.slice(0, -1)) {
        if (typeof t[p] !== "object" || Array.isArray(t[p])) t[p] = {};
        t = t[p] as TomlTable;
      }
      t[path.at(-1)!] = v;
      skipSpace();
      if (peek() === "#" || peek() === "\r" || peek() === "\n") skipLine();
    }
  }
  return root;
}
