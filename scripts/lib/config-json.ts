/**
 * JSON.parse checks the grammar first. Walk its tokens before accepting the
 * result, retaining each object's decoded keys so escapes cannot hide duplicates.
 * This build-only reader uses no dependency and never reports config values.
 */
export function parseConfigJson(source: string): unknown {
  const value: unknown = JSON.parse(source);
  const tokens = source.match(/"(?:[^"\\]|\\[\s\S])*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  let index = 0;
  const walk = (): void => {
    const token = tokens[index++];
    if (token === "{") {
      const keys = new Set<string>();
      if (tokens[index] === "}") {
        index++;
        return;
      }
      while (true) {
        const key = JSON.parse(tokens[index++] as string) as string;
        if (keys.has(key)) throw new Error("Invalid config: duplicate JSON key");
        keys.add(key);
        index++; // colon; grammar already checked
        walk();
        if (tokens[index++] === "}") return;
      }
    }
    if (token === "[") {
      if (tokens[index] === "]") {
        index++;
        return;
      }
      while (true) {
        walk();
        if (tokens[index++] === "]") return;
      }
    }
  };
  walk();
  return value;
}
