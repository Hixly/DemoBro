"use client";

import { useState, type FormEvent } from "react";
import {
  isFormValid,
  validateGithubUrl,
  validateLiveUrl,
  type FieldError,
} from "@/lib/validate";

export function InputForm() {
  const [liveUrl, setLiveUrl] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [liveTouched, setLiveTouched] = useState(false);
  const [githubTouched, setGithubTouched] = useState(false);
  const [submittedNote, setSubmittedNote] = useState<string | null>(null);

  const liveError: FieldError = liveTouched ? validateLiveUrl(liveUrl) : null;
  const githubError: FieldError = githubTouched
    ? validateGithubUrl(githubUrl)
    : null;
  const canSubmit = isFormValid(liveUrl, githubUrl);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLiveTouched(true);
    setGithubTouched(true);

    if (!isFormValid(liveUrl, githubUrl)) return;

    // Checkpoint 1: UI only — pipeline starts at later checkpoints.
    setSubmittedNote(
      "Looks good. Repo ingest and recording come next — nothing queued yet.",
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
      <p className="font-heading text-[15px] font-semibold leading-snug text-ink -rotate-1 origin-left">
        Drop your links. We film the tour.
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
          onChange={(e) => {
            setLiveUrl(e.target.value);
            setSubmittedNote(null);
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
          onChange={(e) => {
            setGithubUrl(e.target.value);
            setSubmittedNote(null);
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
        Generate demo
      </button>

      <p className="text-center text-[13px] leading-relaxed text-ink/55">
        Your project needs to be deployed and publicly accessible — a
        vercel.app or netlify.app URL works fine.
      </p>

      {submittedNote ? (
        <p
          role="status"
          className="rounded-xl border-2 border-accent bg-accent-soft px-3 py-2 text-center font-heading text-sm font-semibold text-accent rotate-1"
        >
          {submittedNote}
        </p>
      ) : null}
    </form>
  );
}
