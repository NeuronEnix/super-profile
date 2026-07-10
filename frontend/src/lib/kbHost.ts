// The same SPA bundle is served on the app origin (sp.hyugorix.com) and on customer docs
// domains (Cloudflare for SaaS custom hostnames, e.g. docs.customer.com). On a customer
// domain the app boots in KB-only mode: `/` is the help center, `/a/:slug` is an article.
const APP_HOSTNAMES = new Set(["sp.hyugorix.com", "localhost", "127.0.0.1"]);

export const isCustomKbHost =
  !APP_HOSTNAMES.has(window.location.hostname) && !window.location.hostname.endsWith(".workers.dev");
