export type DigestArticle = { title: string; slug: string; collection: string | null; excerpt: string };

export function buildGistPrompt(articles: DigestArticle[]): string {
  const list = articles.map((a, i) => `${i + 1}. ${a.title}\n${a.excerpt}`).join("\n\n");
  return (
    "For each numbered documentation article below, write ONE short sentence (max 20 words) saying what it covers. " +
    "Output exactly one line per article in the format `N. sentence`, same numbering, nothing else.\n\n" + list
  );
}

export function parseGists(response: string, count: number): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of response.split("\n")) {
    const m = /^\s*(\d+)[.):]\s+(.{3,})$/.exec(line.trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= count && !map.has(n)) map.set(n, m[2].trim());
  }
  return map;
}

/** The digest structure and every URL are built by US — the model only contributes gists,
 * so it can never hallucinate a link. */
export function composeDigest(
  articles: DigestArticle[],
  gists: Map<number, string>,
  urlBase: string,
  charCap: number,
): string {
  const groups = new Map<string, string[]>();
  articles.forEach((a, i) => {
    const gist = gists.get(i + 1);
    const line = `- [${a.title}](${urlBase}/a/${a.slug})${gist ? ` — ${gist}` : ""}`;
    const key = a.collection ?? "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(line);
  });
  let out = "";
  for (const [name, lines] of groups) out += `### ${name}\n${lines.join("\n")}\n\n`;
  return out.trim().slice(0, charCap);
}
