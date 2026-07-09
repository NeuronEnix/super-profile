import { CONVERSATION } from "../common/const";

export function truncatePreview(text: string, max = 120): string {
  return text.length > max ? text.slice(0, max) : text;
}

export function shouldReopen(senderType: string, currentStatus: string): boolean {
  return senderType === "CONTACT" && currentStatus !== CONVERSATION.STATUS.OPEN;
}

export function encodeConversationCursor(lastMessageAt: number, id: string): string {
  return btoa(JSON.stringify([lastMessageAt, id]));
}

export function decodeConversationCursor(cursor: string): { lastMessageAt: number; id: string } | null {
  try {
    const [lastMessageAt, id] = JSON.parse(atob(cursor));
    if (typeof lastMessageAt !== "number" || typeof id !== "string") return null;
    return { lastMessageAt, id };
  } catch {
    return null;
  }
}
