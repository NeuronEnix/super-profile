/** WhatsApp-style delivery ticks + typing dots, used for CHAT conversations only. */

const GREY = "#8696a0";
const BLUE = "#53bdeb";

export type TickState = "sent" | "delivered" | "read";

/**
 * ✓ sent · ✓✓ delivered (grey) · ✓✓ read (blue) — mirrors WhatsApp. `onColor` renders it for a
 * colored/dark outgoing bubble (white-ish ticks, bright-blue when read) instead of on white.
 */
export function Ticks({ state, onColor }: { state: TickState; onColor?: boolean }) {
  const color =
    state === "read" ? (onColor ? "#7dd3fc" : BLUE) : onColor ? "rgba(255,255,255,0.85)" : GREY;
  const double = state !== "sent";
  return (
    <svg
      viewBox="0 0 18 12"
      width="16"
      height="11"
      fill="none"
      stroke={color}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label={state}
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      {double && <path d="M1 6.5 4.3 9.7 9.4 3" />}
      <path d={double ? "M6.6 6.5 9.9 9.7 17 3" : "M2.5 6.5 6.5 10.3 14 2.5"} />
    </svg>
  );
}

/** Three subtly-bouncing dots inside an incoming bubble — "the other side is typing". */
export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-[3px] py-0.5" aria-label="typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-slate-400"
          style={{ animation: "sp-typing 1.2s ease-in-out infinite", animationDelay: `${i * 0.18}s` }}
        />
      ))}
      <style>{`@keyframes sp-typing{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}`}</style>
    </span>
  );
}
