/** Symbol slots in one word gap; position is irrelevant without numbers. */
export function symbolSlots(options: { symbol: boolean; number: boolean; symbolPosition: string }): number {
  return options.symbol ? (options.number && options.symbolPosition === "both" ? 2 : 1) : 0;
}

/**
 * Balanced prefixes are permutations of successive complete alphabet rounds.
 * A round that starts inside a two-slot gap forbids the preceding symbol.
 * Every node at the same depth has the same number of children, so uniform
 * picks from these children sample complete valid sequences uniformly.
 */
export function uniqueSymbolCount(alphabet: number, gaps: number, slots: number): bigint {
  let count = 1n;
  for (let i = 0; i < gaps * slots; i++) {
    const remaining = alphabet - (i % alphabet);
    count *= BigInt(remaining - (i % alphabet === 0 && i % slots !== 0 ? 1 : 0));
  }
  return count;
}
