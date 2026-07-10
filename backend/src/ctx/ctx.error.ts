type TCtxErrorData = {
  [key: string]: number | string | object | boolean | null;
};

type TCtxError = {
  name: string;
  msg: string;
  data?: TCtxErrorData;
  info?: unknown;
};

export class CtxError extends Error {
  data: TCtxErrorData;
  info?: unknown;
  constructor({ name, msg, data, info }: TCtxError) {
    super(msg);
    super.name = name;
    this.data = data || {};
    this.info = info;
  }
}

type TResErr = Partial<Pick<TCtxError, "data" | "info" | "msg">>;

export namespace ctxErr {
  export const general = {
    unknown: (e?: TResErr) =>
      new CtxError({ name: "UNKNOWN_ERROR", msg: "Something went wrong", ...e }),
    notFound: (e?: TResErr) => new CtxError({ name: "NOT_FOUND", msg: "Not found", ...e }),
    invalidRequestData: (e?: TResErr) =>
      new CtxError({ name: "INVALID_REQUEST_DATA", msg: "Invalid request data", ...e }),
  };

  export const auth = {
    invalidToken: (e?: TResErr) =>
      new CtxError({ name: "INVALID_TOKEN", msg: "Invalid or expired link", ...e }),
    tokenExpired: (e?: TResErr) =>
      new CtxError({ name: "TOKEN_EXPIRED", msg: "This link has expired or already been used", ...e }),
    expiredAccessToken: (e?: TResErr) =>
      new CtxError({ name: "EXPIRED_ACCESS_TOKEN", msg: "Session expired, please sign in again", ...e }),
    invalidAccessToken: (e?: TResErr) =>
      new CtxError({ name: "INVALID_ACCESS_TOKEN", msg: "Invalid access token", ...e }),
    notAuthorized: (e?: TResErr) =>
      new CtxError({ name: "NOT_AUTHORIZED", msg: "You are not authorized to perform this action", ...e }),
    invalidRefreshToken: (e?: TResErr) =>
      new CtxError({ name: "INVALID_REFRESH_TOKEN", msg: "Please sign in again", ...e }),
  };

  export const workspace = {
    notFound: (e?: TResErr) =>
      new CtxError({ name: "WORKSPACE_NOT_FOUND", msg: "Workspace not found", ...e }),
    notMember: (e?: TResErr) =>
      new CtxError({ name: "WORKSPACE_NOT_MEMBER", msg: "You are not a member of this workspace", ...e }),
    adminRequired: (e?: TResErr) =>
      new CtxError({ name: "WORKSPACE_ADMIN_REQUIRED", msg: "Only workspace admins can do this", ...e }),
    slugTaken: (e?: TResErr) =>
      new CtxError({ name: "WORKSPACE_SLUG_TAKEN", msg: "That workspace handle is already taken", ...e }),
  };

  export const user = {
    notFound: (e?: TResErr) => new CtxError({ name: "USER_NOT_FOUND", msg: "User not found", ...e }),
  };

  export const invite = {
    notFound: (e?: TResErr) => new CtxError({ name: "INVITE_NOT_FOUND", msg: "Invite not found", ...e }),
    expired: (e?: TResErr) =>
      new CtxError({ name: "INVITE_EXPIRED", msg: "This invite has expired or already been used", ...e }),
    alreadyMember: (e?: TResErr) =>
      new CtxError({ name: "INVITE_ALREADY_MEMBER", msg: "Already a member", ...e }),
  };

  export const conversation = {
    notFound: (e?: TResErr) =>
      new CtxError({ name: "CONVERSATION_NOT_FOUND", msg: "Conversation not found", ...e }),
    assignedToOther: (e?: TResErr) =>
      new CtxError({
        name: "CONVERSATION_ASSIGNED_TO_OTHER",
        msg: "This conversation is assigned to someone else. Reassign it to yourself to reply.",
        ...e,
      }),
  };

  export const kb = {
    collectionNotFound: (e?: TResErr) =>
      new CtxError({ name: "KB_COLLECTION_NOT_FOUND", msg: "Collection not found", ...e }),
    articleNotFound: (e?: TResErr) =>
      new CtxError({ name: "KB_ARTICLE_NOT_FOUND", msg: "Article not found", ...e }),
    slugTaken: (e?: TResErr) =>
      new CtxError({ name: "KB_SLUG_TAKEN", msg: "That slug is already in use", ...e }),
  };

  export const widget = {
    invalidKey: (e?: TResErr) =>
      new CtxError({ name: "WIDGET_INVALID_KEY", msg: "Invalid widget key", ...e }),
    invalidToken: (e?: TResErr) =>
      new CtxError({ name: "WIDGET_INVALID_TOKEN", msg: "Invalid widget session", ...e }),
  };

  export const email = {
    sendFailed: (e?: TResErr) =>
      new CtxError({ name: "EMAIL_SEND_FAILED", msg: "Failed to send email", ...e }),
    invalidInbound: (e?: TResErr) =>
      new CtxError({ name: "EMAIL_INVALID_INBOUND", msg: "Invalid inbound email payload", ...e }),
  };

  export const domain = {
    alreadyUsed: (e?: TResErr) =>
      new CtxError({
        name: "DOMAIN_ALREADY_USED",
        msg: "This domain is already connected to a workspace",
        ...e,
      }),
    reserved: (e?: TResErr) =>
      new CtxError({ name: "DOMAIN_RESERVED", msg: "This domain can't be connected", ...e }),
    notFound: (e?: TResErr) =>
      new CtxError({ name: "DOMAIN_NOT_FOUND", msg: "Domain not found", ...e }),
    verificationFailed: (e?: TResErr) =>
      new CtxError({ name: "DOMAIN_VERIFICATION_FAILED", msg: "Domain verification failed", ...e }),
  };

  export const ai = {
    unavailable: (e?: TResErr) =>
      new CtxError({ name: "AI_UNAVAILABLE", msg: "AI is unavailable right now, try again shortly", ...e }),
    notAssignee: (e?: TResErr) =>
      new CtxError({
        name: "AI_NOT_ASSIGNEE",
        msg: "Only the assigned agent can do this — assign the conversation to yourself first",
        ...e,
      }),
    handlingLocked: (e?: TResErr) =>
      new CtxError({
        name: "AI_HANDLING_LOCKED",
        msg: "AI is handling this conversation. Take over to reply yourself.",
        ...e,
      }),
  };

  export const rateLimit = {
    exceeded: (e?: TResErr) =>
      new CtxError({ name: "RATE_LIMIT_EXCEEDED", msg: "Too many requests, please slow down", ...e }),
  };
}
