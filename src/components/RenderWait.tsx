"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEMOBRO_FACTS } from "@/lib/demobro-facts";
import {
  PIPELINE_STAGES,
  type PipelineStageId,
} from "@/lib/pipeline-stages";

type Props = {
  currentStage: PipelineStageId;
  error?: string | null;
  notifyEnabled: boolean;
  onNotifyChange: (enabled: boolean) => void;
};

function shuffleFacts(pool: string[]): string[] {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function RenderWait({
  currentStage,
  error = null,
  notifyEnabled,
  onNotifyChange,
}: Props) {
  const reduceMotion = useReducedMotion();
  const [notifyHint, setNotifyHint] = useState<string | null>(null);

  const deckRef = useRef<string[]>([]);
  const [fact, setFact] = useState(() => {
    const deck = shuffleFacts(DEMOBRO_FACTS);
    deckRef.current = deck.slice(1);
    return deck[0] ?? DEMOBRO_FACTS[0];
  });
  const [factKey, setFactKey] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (deckRef.current.length === 0) {
        deckRef.current = shuffleFacts(DEMOBRO_FACTS);
      }
      const next = deckRef.current.shift();
      if (!next) return;
      setFact(next);
      setFactKey((k) => k + 1);
    }, 9000);
    return () => window.clearInterval(id);
  }, []);

  async function toggleNotify() {
    if (typeof Notification === "undefined") {
      setNotifyHint("Notifications aren’t supported in this browser.");
      return;
    }

    if (!notifyEnabled) {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        onNotifyChange(false);
        setNotifyHint("Notification permission was denied.");
        return;
      }
      onNotifyChange(true);
      setNotifyHint("We’ll ping you when the video is ready.");
      return;
    }

    onNotifyChange(false);
    setNotifyHint(null);
  }

  const stageIndex = useMemo(
    () => PIPELINE_STAGES.findIndex((s) => s.id === currentStage),
    [currentStage],
  );

  return (
    <div className="flex flex-col gap-5">
      {/* 1. Working indicator */}
      <div className="flex flex-col items-center gap-3 pt-1">
        <motion.div
          className="flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-ink bg-accent shadow-[3px_3px_0_var(--ink)]"
          animate={
            reduceMotion
              ? { opacity: [0.75, 1, 0.75] }
              : {
                  rotate: [-6, 6, -4, 5, -6],
                  y: [0, -4, 0, -2, 0],
                  scale: [1, 1.05, 0.98, 1.03, 1],
                }
          }
          transition={
            reduceMotion
              ? { duration: 2.2, repeat: Infinity, ease: "easeInOut" }
              : { duration: 2.4, repeat: Infinity, ease: "easeInOut" }
          }
          aria-hidden
        >
          <span className="font-heading text-xl font-bold text-ink">▶</span>
        </motion.div>
        <p className="text-center font-heading text-[15px] font-semibold text-ink -rotate-1">
          Working on your demo…
        </p>
        <p className="text-center text-[13px] leading-snug text-ink/55">
          This usually takes a few minutes — grab a coffee.
        </p>
      </div>

      {/* 2. Current stage */}
      <ol className="flex flex-col gap-2" aria-label="Demo progress">
        {PIPELINE_STAGES.map((step, index) => {
          const active = index === stageIndex;
          const done = index < stageIndex;
          return (
            <li
              key={step.id}
              className={`rounded-xl border-2 px-3 py-2 font-heading text-sm font-semibold transition-colors ${
                active
                  ? "border-ink bg-accent text-ink shadow-[3px_3px_0_var(--ink)] -rotate-1"
                  : done
                    ? "border-ink/25 bg-accent-soft text-ink/70"
                    : "border-ink/15 bg-white text-ink/35"
              }`}
              aria-current={active ? "step" : undefined}
            >
              <span className="mr-2 font-mono text-[11px] opacity-70">
                {done ? "✓" : active ? "→" : "·"}
              </span>
              {step.label}
            </li>
          );
        })}
      </ol>

      {/* 3. Fact card */}
      <div className="relative min-h-[7.5rem] overflow-hidden rounded-xl border-2 border-ink bg-white p-4 shadow-[3px_3px_0_var(--accent)] rotate-1">
        <p className="mb-2 font-heading text-[11px] font-bold uppercase tracking-wide text-accent">
          Did you know?
        </p>
        <AnimatePresence mode="wait">
          <motion.p
            key={factKey}
            className="font-heading text-[14px] font-medium leading-snug text-ink"
            initial={
              reduceMotion
                ? { opacity: 1 }
                : { opacity: 0, y: 12, scale: 0.97, rotate: -1 }
            }
            animate={{ opacity: 1, y: 0, scale: 1, rotate: 0 }}
            exit={
              reduceMotion
                ? { opacity: 0 }
                : { opacity: 0, y: -10, scale: 0.98, rotate: 1 }
            }
            transition={{ type: "spring", stiffness: 380, damping: 22 }}
          >
            {fact}
          </motion.p>
        </AnimatePresence>
      </div>

      {/* 4. Keep tab open */}
      <p className="text-center text-[12px] font-medium text-ink/50">
        Keep this tab open while we work.
      </p>

      {/* 5. Notify toggle */}
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border-2 border-ink bg-background px-3 py-2.5 -rotate-1">
        <span className="font-heading text-sm font-semibold text-ink">
          Notify me when it’s ready
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={notifyEnabled}
          onClick={() => void toggleNotify()}
          className={`relative h-7 w-12 shrink-0 rounded-full border-2 border-ink transition-colors ${
            notifyEnabled ? "bg-accent" : "bg-white"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full border-2 border-ink bg-white shadow-[1px_1px_0_var(--ink)] transition-transform ${
              notifyEnabled ? "left-5" : "left-0.5"
            }`}
          />
        </button>
      </label>
      {notifyHint ? (
        <p className="text-center text-[11px] text-ink/45">{notifyHint}</p>
      ) : null}

      {error ? (
        <p role="alert" className="text-center text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
