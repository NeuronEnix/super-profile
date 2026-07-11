import { splitLinkified } from "./linkifyCore";

/**
 * Renders message text with bare http(s) URLs as clickable links (AI replies cite KB article
 * URLs). Plain string splitting — no HTML parsing, so no injection surface. Trailing sentence
 * punctuation stays text — see splitLinkified.
 */
export function Linkified({ text }: { text: string }) {
  return (
    <>
      {splitLinkified(text).map((part, i) =>
        part.link ? (
          <a
            key={i}
            href={part.value}
            target="_blank"
            rel="noreferrer"
            className="break-all underline underline-offset-2 opacity-90 hover:opacity-100"
          >
            {part.value}
          </a>
        ) : (
          part.value
        ),
      )}
    </>
  );
}
