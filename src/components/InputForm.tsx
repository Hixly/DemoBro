"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { DownloadScreen } from "@/components/DownloadScreen";
import { RenderWait } from "@/components/RenderWait";
import { resolvePipelineStage } from "@/lib/pipeline-stages";
import {
  isFormValid,
  validateGithubUrl,
  validateLiveUrl,
  type FieldError,
} from "@/lib/validate";

type Stage = "input" | "reading" | "fallback" | "working" | "ready";

type ProjectMeta = {
  title: string;
  description: string;
  badges: string[];
};

type JobPoll = {
  id: string;
  status: string;
  stage?: string | null;
  title?: string;
  videoUrl?: string | null;
  error?: string | null;
};

/** Client-side backstop so "Discovering…" never spins forever. */
const CLIENT_JOB_TIMEOUT_MS = 8 * 60 * 1000;
const POLL_FAIL_STREAK_LIMIT = 5;

export function InputForm() {
  const [liveUrl, setLiveUrl] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [liveTouched, setLiveTouched] = useState(false);
  const [githubTouched, setGithubTouched] = useState(false);
  const [stage, setStage] = useState<Stage>("input");
  const [manualTitle, setManualTitle] = useState("");
  const [fallbackMessage, setFallbackMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(null);
  const [job, setJob] = useState<JobPoll | null>(null);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedRef = useRef<number>(0);
  const pollFailStreakRef = useRef(0);
  const notifiedRef = useRef(false);
  const notifyEnabledRef = useRef(false);
  const projectTitleRef = useRef<string | undefined>(undefined);
  notifyEnabledRef.current = notifyEnabled;
  projectTitleRef.current = projectMeta?.title;

  const liveError: FieldError = liveTouched ? validateLiveUrl(liveUrl) : null;
  const githubError: FieldError = githubTouched
    ? validateGithubUrl(githubUrl)
    : null;
  const busy = stage === "reading" || stage === "working";
  const canSubmit = isFormValid(liveUrl, githubUrl) && !busy;

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function failWorking(message: string) {
    stopPolling();
    setStage("input");
    setError(message);
  }

  function startPolling(jobId: string) {
    stopPolling();
    pollStartedRef.current = Date.now();
    pollFailStreakRef.current = 0;
    const tick = async () => {
      if (
        pollStartedRef.current &&
        Date.now() - pollStartedRef.current > CLIENT_JOB_TIMEOUT_MS
      ) {
        failWorking(
          "This is taking too long. Check your links and try again.",
        );
        return;
      }

      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        const payload = (await res.json().catch(() => null)) as JobPoll & {
          error?: string;
        } | null;
        if (!res.ok || !payload) {
          pollFailStreakRef.current += 1;
          setError(payload?.error ?? `Job status failed (${res.status})`);
          if (pollFailStreakRef.current >= POLL_FAIL_STREAK_LIMIT) {
            failWorking(
              payload?.error ??
                "Lost connection while checking your demo. Please try again.",
            );
          }
          return;
        }

        pollFailStreakRef.current = 0;
        setJob(payload);
        if (payload.status === "ready" && payload.videoUrl) {
          stopPolling();
          if (
            notifyEnabledRef.current &&
            !notifiedRef.current &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            notifiedRef.current = true;
            try {
              new Notification("DemoBro — video ready", {
                body: `${payload.title || projectTitleRef.current || "Your demo"} is ready to watch.`,
                tag: "demobro-ready",
              });
            } catch {
              // ignore notification failures
            }
          }
          setStage("ready");
          setError(null);
        } else if (payload.status === "failed" || payload.status === "expired") {
          failWorking(payload.error ?? "Recording failed. Please try again.");
        }
      } catch (err) {
        pollFailStreakRef.current += 1;
        const msg = err instanceof Error ? err.message : "Polling failed.";
        setError(msg);
        if (pollFailStreakRef.current >= POLL_FAIL_STREAK_LIMIT) {
          failWorking(
            "Lost connection while checking your demo. Please try again.",
          );
        }
      }
    };

    void tick();
    pollRef.current = setInterval(() => void tick(), 2500);
  }

  /**
   * Enqueue an agent job — the worker discovers the tour while filming.
   * No pre-baked storyboard editor (that would fake a complete plan).
   */
  async function startAgentJob(meta: {
    title: string;
    description: string;
    badges: string[];
  }) {
    setError(null);
    setStage("working");
    setProjectMeta(meta);

    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        liveUrl: liveUrl.trim(),
        githubUrl: githubUrl.trim(),
        title: meta.title,
        description: meta.description,
        badges: meta.badges,
        mode: "agent",
        steps: [],
      }),
    });
    const payload = (await res.json().catch(() => null)) as {
      id?: string;
      error?: string;
    } | null;
    if (!res.ok || !payload?.id) {
      throw new Error(payload?.error ?? `Could not start job (${res.status})`);
    }
    setJob({ id: payload.id, status: "queued", stage: "queued" });
    startPolling(payload.id);
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
      const ingestController = new AbortController();
      const ingestTimer = window.setTimeout(
        () => ingestController.abort(),
        45_000,
      );
      let ingestRes: Response;
      try {
        ingestRes = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ githubUrl: githubUrl.trim() }),
          signal: ingestController.signal,
        });
      } catch (err) {
        const name = err && typeof err === "object" ? (err as { name?: string }).name : "";
        if (name === "AbortError") {
          throw new Error(
            "Reading that repo took too long. Enter a title manually or try again.",
          );
        }
        throw err;
      } finally {
        window.clearTimeout(ingestTimer);
      }

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
        title?: string;
        description?: string;
        badges?: string[];
      };

      if (ingest.status === "fallback") {
        setManualTitle(ingest.suggestedTitle ?? "");
        setFallbackMessage(
          ingest.message ?? "Couldn’t read that repo — enter a title to continue.",
        );
        setStage("fallback");
        return;
      }

      await startAgentJob({
        title: ingest.title ?? "Untitled project",
        description: ingest.description ?? "",
        badges: ingest.badges ?? [],
      });
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
      await startAgentJob({
        title: manualTitle.trim(),
        description: "",
        badges: [],
      });
    } catch (err) {
      setStage("fallback");
      setError(err instanceof Error ? err.message : "Could not start demo.");
    }
  }

  function resetAll() {
    stopPolling();
    setStage("input");
    setProjectMeta(null);
    setJob(null);
    setError(null);
    setFallbackMessage(null);
    setNotifyEnabled(false);
    notifiedRef.current = false;
  }

  function shell(children: ReactNode, opts?: { wide?: boolean }) {
    return (
      <section
        className={`stamp-card relative mx-auto w-full p-6 sm:p-7 ${
          opts?.wide
            ? "max-w-3xl translate-x-0 rotate-0 lg:rotate-[0.5deg]"
            : "max-w-[26rem] translate-x-2 rotate-[2.5deg] sm:translate-x-3"
        }`}
      >
        {children}
      </section>
    );
  }

  if (stage === "ready" && job?.videoUrl) {
    return shell(
      <DownloadScreen
        title={job.title || projectMeta?.title || "Your demo"}
        videoUrl={job.videoUrl}
        onAnother={resetAll}
      />,
    );
  }

  if (stage === "reading" || stage === "working") {
    return shell(
      <RenderWait
        currentStage={resolvePipelineStage(stage, job?.stage)}
        notifyEnabled={notifyEnabled}
        onNotifyChange={setNotifyEnabled}
        error={error}
        onCancel={() =>
          failWorking("Cancelled. Fix your links and try again.")
        }
      />,
    );
  }

  if (stage === "fallback") {
    return shell(
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
          Discover & film tour
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
      </form>,
    );
  }

  return shell(
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
        Generate demo
      </button>

      <p className="text-center text-[13px] leading-relaxed text-ink/55">
        Your project needs a public URL — railway.app, Vercel, Netlify, or any
        live link works.
      </p>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border-2 border-danger/40 bg-white px-3 py-3 text-center rotate-1"
        >
          <p className="font-heading text-sm font-semibold text-danger">
            {error}
          </p>
          <p className="mt-1 text-[12px] font-medium text-ink/55">
            Fix the links above and hit Generate demo to try again.
          </p>
        </div>
      ) : null}
    </form>,
  );
}
