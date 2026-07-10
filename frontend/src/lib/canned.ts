export function matchCanned<T extends { title: string; tags: string }>(list: T[], query: string, limit = 8): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  return list.filter((r) => r.title.toLowerCase().includes(q) || r.tags.toLowerCase().includes(q)).slice(0, limit);
}
