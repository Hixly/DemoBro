"use client";

import { useState, type FormEvent } from "react";
import type { RepoIngestResult } from "@/lib/github";
import {
  isFormValid,
  validateGithubUrl,
  validateLiveUrl,
  type FieldError,
} from "@/lib/validate";

type Stage = "input" | "reading" | "result";

export function InputForm() {
  const [liveUrl, setLiveUrl] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [liveTouched, setLiveTouched] = useState(false);
  const [githubTouched, setGithubTouched] = useState(false);
  const [stage, setStage] = useState<Stage>("input");
  const [ingest, setIngest] = useState<RepoIngestResult | null>(null);
  const [manualTitle, setManualTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const liveError: FieldError = liveTouched ? validateLiveUrl(liveUrl) : null;
  const githubError: FieldError = githubTouched
    ? validateGithubUrl(githubUrl)
    : null;
  const canSubmit = isFormValid(liveUrl, githubUrl) && stage !== "reading";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLiveTouched(true);
    setGithubTouched(true);
    setError(null);

    if (!isFormValid(liveUrl, githubUrl)) return;

    setStage("reading");
    setIngest(null);

    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUrl: githubUrl.trim() }),
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? `Ingest failed (${res.status})`);
      }

      const result = (await res.json()) as RepoIngestResult;
      setIngest(result);
      if (result.status === "fallback") {
        setManualTitle(result.suggestedTitle);
      }
      setStage("result");
    } catch (err) {
      setStage("input");
      setError(
        err instanceof Error ? err.message : "Couldn’t read that repo.",
      );
    }
  }

  if (stage === "result" && ingest) {
    return (
      <div className="flex flex-col gap-4">
        <p className="font-heading text-[15px] font-semibold leading-snug text-ink -rotate-1 origin-left">
          {ingest.status === "ok" ? "Reading your repo" : "Couldn’t read that repo"}
        </p>

        {ingest.status === "ok" ? (
          <>
            <div className="rounded-xl border-2 border-ink bg-background p-3 -rotate-1">
              <p className="font-heading text-lg font-bold text-ink">
                {ingest.title}
              </p>
              <p className="mt-1 text-sm leading-snug text-ink/70">
                {ingest.description}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {ingest.badges.map((badge) => (
                  <span key={badge} className="stamp-badge font-heading">
                    {badge}
                  </span>
                ))}
              </div>
            </div>
            <p className="font-mono text-[11px] text-ink/45">
              {ingest.owner}/{ingest.repo} · checkpoint 3 — storyboard next
            </p>
          </>
        ) : (
          <>
            <p className="rounded-xl border-2 border-danger/40 bg-white px-3 py-2 text-sm font-medium text-danger rotate-1">
              {ingest.message}
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="font-heading text-sm font-semibold text-ink">
                Project title
              </span>
              <input
                type="text"
                name="manualTitle"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="Name your project"
                className="stamp-input font-heading text-sm"
              />
            </label>
            <p className="text-[13px] leading-relaxed text-ink/55">
              Private or missing repos don’t block you — add a title and keep
              going.
            </p>
          </>
        )}

        <button
          type="button"
          onClick={() => {
            setStage("input");
            setIngest(null);
            setError(null);
          }}
          className="stamp-button font-heading -rotate-1"
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
      <p className="font-heading text-[15px] font-semibold leading-snug text-ink -rotate-1 origin-left">
        {stage === "reading"
          ? "Reading your repo…"
          : "Drop your links. We film the tour."}
      </p>

      <label className="flex flex-col gap-1.5">
        <span className="font-heading text-sm font-semibold text-ink">
          Live URL
        </span>
        <input
          type="url"
          name="liveUrl"
          inputMode="url"
          autoComplete="url"
          placeholder="https://your-app.vercel.app"
          value={liveUrl}
          disabled={stage === "reading"}
          onChange={(e) => {
            setLiveUrl(e.target.value);
            setError(null);
          }}
          onBlur={() => setLiveTouched(true)}
          aria-invalid={liveError ? true : undefined}
          aria-describedby={liveError ? "live-url-error" : undefined}
          className="stamp-input font-mono text-sm"
        />
        {liveError ? (
          <span id="live-url-error" className="text-sm font-medium text-danger">
            {liveError}
          </span>
        ) : null}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="font-heading text-sm font-semibold text-ink">
          GitHub repo
        </span>
        <input
          type="url"
          name="githubUrl"
          inputMode="url"
          autoComplete="off"
          placeholder="https://github.com/owner/repo"
          value={githubUrl}
          disabled={stage === "reading"}
          onChange={(e) => {
            setGithubUrl(e.target.value);
            setError(null);
          }}
          onBlur={() => setGithubTouched(true)}
          aria-invalid={githubError ? true : undefined}
          aria-describedby={githubError ? "github-url-error" : undefined}
          className="stamp-input font-mono text-sm"
        />
        {githubError ? (
          <span
            id="github-url-error"
            className="text-sm font-medium text-danger"
          >
            {githubError}
          </span>
        ) : null}
      </label>

      <button
        type="submit"
        disabled={!canSubmit}
        className="stamp-button font-heading mt-1 -rotate-1 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:translate-y-0"
      >
        {stage === "reading" ? "Reading your repo…" : "Generate demo"}
      </button>

      <p className="text-center text-[13px] leading-relaxed text-ink/55">
        Your project needs to be deployed and publicly accessible — a
        vercel.app or netlify.app URL works fine.
      </p>

      {error ? (
        <p
          role="alert"
          className="rounded-xl border-2 border-danger/40 bg-white px-3 py-2 text-center font-heading text-sm font-semibold text-danger rotate-1"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
