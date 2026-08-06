"use client";

import { useState, type FormEvent } from "react";
import { StoryboardEditor } from "@/components/StoryboardEditor";
import type { StoryboardStep } from "@/lib/storyboard";
import {
  isFormValid,
  validateGithubUrl,
  validateLiveUrl,
  type FieldError,
} from "@/lib/validate";

type Stage =
  | "input"
  | "reading"
  | "fallback"
  | "planning"
  | "storyboard";

type StoryboardPayload = {
  title: string;
  description: string;
  badges: string[];
  steps: StoryboardStep[];
  model?: string;
};

export function InputForm() {
  const [liveUrl, setLiveUrl] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [liveTouched, setLiveTouched] = useState(false);
  const [githubTouched, setGithubTouched] = useState(false);
  const [stage, setStage] = useState<Stage>("input");
  const [manualTitle, setManualTitle] = useState("");
  const [fallbackMessage, setFallbackMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storyboard, setStoryboard] = useState<StoryboardPayload | null>(null);
  const [recordNote, setRecordNote] = useState<string | null>(null);

  const liveError: FieldError = liveTouched ? validateLiveUrl(liveUrl) : null;
  const githubError: FieldError = githubTouched
    ? validateGithubUrl(githubUrl)
    : null;
  const busy = stage === "reading" || stage === "planning";
  const canSubmit = isFormValid(liveUrl, githubUrl) && !busy;

  async function requestStoryboard(manualTitleOverride?: string) {
    setStage("planning");
    setError(null);
    setRecordNote(null);

    const res = await fetch("/api/storyboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        liveUrl: liveUrl.trim(),
        githubUrl: githubUrl.trim(),
        manualTitle: manualTitleOverride?.trim() || undefined,
      }),
    });

    const payload = (await res.json().catch(() => null)) as {
      error?: string;
      title?: string;
      description?: string;
      badges?: string[];
      storyboard?: {
        steps: StoryboardStep[];
        model?: string;
      };
      ingestStatus?: string;
    } | null;

    if (!res.ok || !payload?.storyboard?.steps) {
      throw new Error(payload?.error ?? `Storyboard failed (${res.status})`);
    }

    setStoryboard({
      title: payload.title ?? "Untitled project",
      description: payload.description ?? "",
      badges: payload.badges ?? [],
      steps: payload.storyboard.steps,
      model: payload.storyboard.model,
    });
    setStage("storyboard");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLiveTouched(true);
    setGithubTouched(true);
    setError(null);
    setFallbackMessage(null);

    if (!isFormValid(liveUrl, githubUrl)) return;

    setStage("reading");

    try {
      const ingestRes = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUrl: githubUrl.trim() }),
      });

      if (!ingestRes.ok) {
        const payload = (await ingestRes.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? `Ingest failed (${ingestRes.status})`);
      }

      const ingest = (await ingestRes.json()) as {
        status: "ok" | "fallback";
        message?: string;
        suggestedTitle?: string;
      };

      if (ingest.status === "fallback") {
        setManualTitle(ingest.suggestedTitle ?? "");
        setFallbackMessage(
          ingest.message ?? "Couldn’t read that repo — enter a title to continue.",
        );
        setStage("fallback");
        return;
      }

      await requestStoryboard();
    } catch (err) {
      setStage("input");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  async function continueFromFallback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!manualTitle.trim()) {
      setError("Enter a project title to continue.");
      return;
    }
    try {
      await requestStoryboard(manualTitle);
    } catch (err) {
      setStage("fallback");
      setError(err instanceof Error ? err.message : "Storyboard failed.");
    }
  }

  if (stage === "storyboard" && storyboard) {
    return (
      <div className="flex flex-col gap-3">
        <StoryboardEditor
          title={storyboard.title}
          description={storyboard.description}
          badges={storyboard.badges}
          steps={storyboard.steps}
          model={storyboard.model}
          onChange={(steps) => setStoryboard({ ...storyboard, steps })}
          onRecord={() =>
            setRecordNote(
              "Record is stubbed for checkpoint 4 — no Playwright yet.",
            )
          }
          onBack={() => {
            setStage("input");
            setStoryboard(null);
            setRecordNote(null);
            setError(null);
          }}
        />
        {recordNote ? (
          <p
            role="status"
            className="rounded-xl border-2 border-accent bg-accent-soft px-3 py-2 text-center font-heading text-sm font-semibold text-ink rotate-1"
          >
            {recordNote}
          </p>
        ) : null}
      </div>
    );
  }

  if (stage === "fallback") {
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={continueFromFallback}
        noValidate
      >
        <p className="font-heading text-[15px] font-semibold leading-snug text-ink -rotate-1 origin-left">
          Couldn’t read that repo
        </p>
        {fallbackMessage ? (
          <p className="rounded-xl border-2 border-danger/40 bg-white px-3 py-2 text-sm font-medium text-danger rotate-1">
            {fallbackMessage}
          </p>
        ) : null}
        <label className="flex flex-col gap-1.5">
          <span className="font-heading text-sm font-semibold text-ink">
            Project title
          </span>
          <input
            type="text"
            name="manualTitle"
            value={manualTitle}
            onChange={(e) => {
              setManualTitle(e.target.value);
              setError(null);
            }}
            placeholder="Name your project"
            className="stamp-input font-heading text-sm"
          />
        </label>
        <button type="submit" className="stamp-button font-heading -rotate-1">
          Continue to storyboard
        </button>
        <button
          type="button"
          onClick={() => {
            setStage("input");
            setError(null);
          }}
          className="font-heading text-sm font-semibold text-ink/60 underline-offset-2 hover:underline"
        >
          Back
        </button>
        {error ? (
          <p role="alert" className="text-center text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
      <p className="font-heading text-[15px] font-semibold leading-snug text-ink -rotate-1 origin-left">
        {stage === "reading"
          ? "Reading your repo…"
          : stage === "planning"
            ? "Touring your app…"
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
          disabled={busy}
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
          disabled={busy}
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
        {stage === "reading"
          ? "Reading your repo…"
          : stage === "planning"
            ? "Touring your app…"
            : "Generate demo"}
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

      {recordNote ? (
        <p
          role="status"
          className="rounded-xl border-2 border-accent bg-accent-soft px-3 py-2 text-center font-heading text-sm font-semibold text-ink rotate-1"
        >
          {recordNote}
        </p>
      ) : null}
    </form>
  );
}
