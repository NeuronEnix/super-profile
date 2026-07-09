import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const { showError } = useToast();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api("/api/v1/auth/magic-link", {
        method: "POST",
        body: { email },
        redirectOnAuthFailure: false,
      });
      setSent(true);
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        {sent ? (
          <div data-testid="magic-link-sent">
            <h1 className="mb-1 text-lg font-semibold text-slate-900">Check your inbox</h1>
            <p className="text-sm text-slate-500">
              We sent a sign-in link to <span className="font-medium text-slate-700">{email}</span>. It expires in
              10 minutes.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h1 className="mb-1 text-lg font-semibold text-slate-900">Sign in to SuperProfile</h1>
            <p className="mb-6 text-sm text-slate-500">We'll email you a magic link — no password needed.</p>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="mt-4 w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
            >
              {loading ? "Sending…" : "Send magic link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
