/**
 * Renders message text with bare http(s) URLs as clickable links (AI replies cite KB article
 * URLs). Plain string splitting — no HTML parsing, so no injection surface.
 */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noreferrer"
            className="break-all underline underline-offset-2 opacity-90 hover:opacity-100"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}
