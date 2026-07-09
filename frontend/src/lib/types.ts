export type Role = "ADMIN" | "AGENT";
export type Channel = "CHAT" | "EMAIL";
export type ConversationStatus = "OPEN" | "SNOOZED" | "RESOLVED";
export type SenderType = "CONTACT" | "AGENT" | "SYSTEM";

export type User = { id: string; email: string | null; name: string | null };

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  widgetKey: string;
  widgetColor: string;
  role: Role;
};

export type Member = { userId: string; name: string | null; email: string | null; role: Role };

export type Invite = {
  id: string;
  email: string;
  role: Role;
  expiresAt: number;
  acceptedAt: number | null;
  createdAt: number;
};

export type Contact = { id: string; name: string | null; email: string | null };

export type Conversation = {
  id: string;
  workspaceId: string;
  contactId: string;
  channel: Channel;
  status: ConversationStatus;
  assigneeId: string | null;
  subject: string | null;
  snoozedUntil: number | null;
  lastMessageAt: number;
  lastMessagePreview: string;
  messageCount: number;
  agentLastReadAt: number | null;
  contactLastReadAt: number | null;
  createdAt: number;
  updatedAt: number;
  unread: boolean;
  contact: Contact;
};

/**
 * The DO's raw conversation row, as broadcast over WS — no nested `contact` object and no
 * precomputed `unread` (those are added by the REST list/detail endpoints only). Callers must
 * merge this into any existing `Conversation` they're holding rather than replacing it outright.
 */
export type ConversationSnapshot = Omit<Conversation, "contact" | "unread">;

export type WsEvent =
  | { type: "MESSAGE_CREATED"; conversation: ConversationSnapshot; message: Message }
  | { type: "CONVERSATION_UPDATED"; conversation: ConversationSnapshot }
  | { type: "TYPING"; conversationId: string; from: "AGENT" | "CONTACT"; state: "START" | "STOP" }
  | { type: "PRESENCE"; agentsOnline: number }
  | { type: "READ_RECEIPT"; conversationId: string; by: "AGENT" | "CONTACT"; at: number }
  | { type: "PONG" };

export type Message = {
  id: string;
  conversationId: string;
  workspaceId: string;
  senderType: SenderType;
  senderId: string | null;
  bodyText: string;
  bodyHtml: string | null;
  emailMessageId: string | null;
  emailInReplyTo: string | null;
  createdAt: number;
};

export type ArticleStatus = "DRAFT" | "PUBLISHED";

export type KbCollection = {
  id: string;
  name: string;
  slug: string;
  description: string;
  position: number;
};

export type KbArticle = {
  id: string;
  workspaceId: string;
  collectionId: string | null;
  title: string;
  slug: string;
  bodyMd: string;
  status: ArticleStatus;
  createdBy: string;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type KbSearchHit = { id: string; title: string; slug: string };

export type Summary = { summary: string; generatedAt: number; cached: boolean };
