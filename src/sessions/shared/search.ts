// The words of a query, each to be found whatever its case.
export function searchWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
}
