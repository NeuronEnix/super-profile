export type Env = {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  ATTACHMENTS: R2Bucket;
  WORKSPACE_HUB: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  APP_URL: string;
  INBOUND_DOMAIN: string;
  SEND_DOMAIN: string;
  ENVIRONMENT: string;
  RESEND_API_KEY: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  WIDGET_TOKEN_SECRET: string;
  EMAIL_INBOUND_SECRET: string;
  DEBUG_AUTH_SECRET: string;
};
