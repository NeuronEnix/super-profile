import { CONVERSATION, MESSAGE } from "../common/const";

export function truncatePreview(text: string, max = 120): string {
  return text.length > max ? text.slice(0, max) : text;
}

// Any human reply (a contact OR an agent) to a non-open conversation reopens it. In particular an
// agent replying to a resolved ticket reopens it — and, since resolving unassigns, the message
// UPDATE's auto-assign then claims it for that agent. Only SYSTEM notes never reopen.
export function shouldReopen(senderType: string, currentStatus: string): boolean {
  return senderType !== MESSAGE.SENDER_TYPE.SYSTEM && currentStatus !== CONVERSATION.STATUS.OPEN;
}

/**
 * The assignment lock: an open/snoozed conversation that's assigned to a specific agent is
 * locked to everyone else. Resolved conversations are unassigned/open to all, and an unassigned
 * conversation (assigneeId === null) is claimable by anyone. `agentId` is the viewer/sender.
 */
export function isAssignedToOther(
  status: string,
  assigneeId: string | null,
  agentId: string | null,
): boolean {
  return status !== CONVERSATION.STATUS.RESOLVED && assigneeId != null && assigneeId !== agentId;
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
