export function uuidv7(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const t = BigInt(Date.now());
  b[0] = Number((t >> 40n) & 255n);
  b[1] = Number((t >> 32n) & 255n);
  b[2] = Number((t >> 24n) & 255n);
  b[3] = Number((t >> 16n) & 255n);
  b[4] = Number((t >> 8n) & 255n);
  b[5] = Number(t & 255n);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function now(): number {
  return Date.now();
}
