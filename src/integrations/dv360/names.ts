// Pure name matching for find(): no I/O, clock, timers, crypto, or logging.

export type MatchKind = 'exact' | 'prefix' | 'contains';

const KIND_RANK: Readonly<Record<MatchKind, number>> = { exact: 0, prefix: 1, contains: 2 };

/** Case-insensitive form of a name; Turkish dotted and dotless i fold to plain i. */
export function foldName(text: string): string {
  return text.normalize('NFKC')
    // Before toLowerCase: lowercasing İ alone yields i + U+0307.
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    // NFKC leaves a lowercase i + U+0307 (combining dot above) as two characters.
    .replace(/i̇/g, 'i')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function matchName(foldedQuery: string, name: string): MatchKind | undefined {
  if (foldedQuery === '') return undefined;
  const folded = foldName(name);
  if (folded === foldedQuery) return 'exact';
  if (folded.startsWith(foldedQuery)) return 'prefix';
  return folded.includes(foldedQuery) ? 'contains' : undefined;
}

type Ranked = { readonly kind: MatchKind; readonly folded: string; readonly id: string };

export function compareMatches(a: Ranked, b: Ranked): number {
  const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (byKind !== 0) return byKind;
  // Code-unit order, not localeCompare, so the order doesn't depend on the host's ICU.
  if (a.folded !== b.folded) return a.folded < b.folded ? -1 : 1;
  if (a.id.length !== b.id.length) return a.id.length - b.id.length;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
