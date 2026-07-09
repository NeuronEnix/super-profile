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
  createdAt: number;
  updatedAt: number;
  unread: boolean;
  contact: Contact;
};

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
