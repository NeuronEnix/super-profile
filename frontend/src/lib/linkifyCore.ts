export type LinkPart = { link: boolean; value: string };

// Sentence punctuation that models and humans put right after a URL — never part of it.
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"»›…]+$/;

function unbalancedOpenParens(url: string): number {
  return url.split("(").length - url.split(")").length;
}

/**
 * Splits text into link/text parts. Trailing sentence punctuation is pushed back out of the
 * URL ("…see https://x/a/b." must link to /a/b, not /a/b.) — except closing parens that
 * balance an opening paren inside the URL itself (wiki-style /Foo_(bar) links stay whole).
 */
export function splitLinkified(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  for (const part of text.split(/(https?:\/\/\S+)/g)) {
    if (!part) continue;
    if (!/^https?:\/\//.test(part)) {
      out.push({ link: false, value: part });
      continue;
    }
    let url = part;
    let rest = "";
    const m = TRAILING_PUNCT_RE.exec(url);
    if (m) {
      let cut = m.index;
      while (cut < url.length && url[cut] === ")" && unbalancedOpenParens(url.slice(0, cut)) > 0) {
        cut += 1;
      }
      rest = url.slice(cut);
      url = url.slice(0, cut);
    }
    if (url) out.push({ link: true, value: url });
    if (rest) out.push({ link: false, value: rest });
  }
  return out;
}
