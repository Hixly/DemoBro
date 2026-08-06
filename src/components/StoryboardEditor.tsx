"use client";

import { useState } from "react";
import { StampSharpie } from "@/components/StampSharpie";
import { StoryboardCoach } from "@/components/StoryboardCoach";
import type { StoryboardStep } from "@/lib/storyboard";
import {
  classifyStepKind,
  plainEnglishTarget,
  tipForStepKind,
} from "@/lib/storyboard-ui";

type Props = {
  title: string;
  description: string;
  badges: string[];
  steps: StoryboardStep[];
  model?: string;
  onChange: (steps: StoryboardStep[]) => void;
  onRecord: () => void;
  onBack: () => void;
};

export function StoryboardEditor({
  title,
  description,
  badges,
  steps,
  model,
  onChange,
  onRecord,
  onBack,
}: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState<Record<string, boolean>>({});

  const safeActive = Math.min(activeIndex, Math.max(0, steps.length - 1));
  const activeStep = steps[safeActive];
  const activeKind = activeStep
    ? classifyStepKind(activeStep)
    : ("click" as const);
  const tip = tipForStepKind(activeKind);
  const anyAdvancedOpen = Object.values(advancedOpen).some(Boolean);

  function move(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= steps.length) return;
    const copy = [...steps];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    onChange(copy);
    setActiveIndex(next);
  }

  function remove(index: number) {
    if (steps.length <= 1) return;
    onChange(steps.filter((_, i) => i !== index));
    setActiveIndex((prev) => {
      if (prev === index) return Math.max(0, index - 1);
      if (prev > index) return prev - 1;
      return prev;
    });
  }

  function editDescription(index: number, descriptionValue: string) {
    onChange(
      steps.map((step, i) =>
        i === index ? { ...step, description: descriptionValue } : step,
      ),
    );
  }

  function toggleAdvanced(id: string) {
    setAdvancedOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <p className="font-heading text-[15px] font-semibold leading-snug text-ink -rotate-1 origin-left">
        Tour storyboard
      </p>

      <div className="rounded-xl border-2 border-ink bg-background p-3 -rotate-1">
        <p className="font-heading text-lg font-bold text-ink">{title}</p>
        <p className="mt-1 text-sm leading-snug text-ink/70">{description}</p>
        {badges.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {badges.map((badge, i) => (
              <StampSharpie
                key={badge}
                className={`inline-block ${i % 2 === 0 ? "-rotate-1" : "rotate-1"}`}
                innerClassName="bg-accent-soft px-2.5 py-1.5 font-heading text-[12px] font-semibold text-accent"
              >
                {badge}
              </StampSharpie>
            ))}
          </div>
        ) : null}
      </div>

      <StampSharpie
        className="block w-full rotate-1"
        innerClassName="bg-accent-soft px-3 py-2 text-center font-heading text-[13px] font-semibold leading-snug text-ink"
      >
        Looks about right? Drag to reorder,{" "}
        <span
          className="mx-0.5 inline-flex align-middle rounded-md border-2 border-danger bg-white px-2 py-0.5 font-heading text-xs font-semibold leading-none text-danger"
          aria-hidden
        >
          ✕
        </span>{" "}
        to trim. Shorter tours = punchier videos.
      </StampSharpie>

      {/* Mobile coach — above list; tip tracks active step */}
      <div className="lg:hidden">
        <StoryboardCoach tip={tip} layout="stack" />
      </div>

      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => {
          const kind = classifyStepKind(step);
          const plain = plainEnglishTarget(step, kind);
          const isActive = index === safeActive;
          const showAdvanced = Boolean(advancedOpen[step.id]);
          const stepTip = tipForStepKind(kind);

          return (
            <li key={step.id} className="flex items-start gap-3 lg:gap-4">
              {/* Desktop: coach sits beside the active card and travels with it */}
              <div className="hidden w-[9.5rem] shrink-0 justify-center overflow-visible pt-2 lg:flex">
                {isActive ? (
                  <StoryboardCoach tip={stepTip} layout="gutter" />
                ) : null}
              </div>

              <div
                role="button"
                tabIndex={0}
                onClick={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveIndex(index);
                  }
                }}
                className={`min-w-0 flex-1 rounded-xl border-2 border-ink bg-white p-3 text-left outline-none transition-shadow ${
                  isActive
                    ? "shadow-[4px_4px_0_var(--accent)] ring-2 ring-accent"
                    : "shadow-[3px_3px_0_var(--accent)] opacity-95"
                }`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-heading text-sm font-bold text-ink">
                    Step {index + 1}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      aria-label="Move step up"
                      title="Move up"
                      disabled={index === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        move(index, -1);
                      }}
                      className="rounded-md border-2 border-ink bg-accent-soft px-2 py-0.5 font-heading text-xs font-semibold text-ink disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Move step down"
                      title="Move down"
                      disabled={index === steps.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        move(index, 1);
                      }}
                      className="rounded-md border-2 border-ink bg-accent-soft px-2 py-0.5 font-heading text-xs font-semibold text-ink disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label="Trim this step"
                      title="Trim this step"
                      disabled={steps.length <= 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(index);
                      }}
                      className="rounded-md border-2 border-danger bg-white px-2 py-0.5 font-heading text-xs font-semibold text-danger disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <label className="flex flex-col gap-1">
                  <span className="font-heading text-xs font-semibold text-ink/70">
                    What happens
                  </span>
                  <textarea
                    value={step.description}
                    onChange={(e) => editDescription(index, e.target.value)}
                    onFocus={() => setActiveIndex(index)}
                    rows={2}
                    className="stamp-input font-heading text-sm"
                  />
                </label>

                <p className="mt-2 font-heading text-[13px] font-medium leading-snug text-ink/75">
                  {plain}
                </p>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleAdvanced(step.id);
                  }}
                  className="mt-1.5 font-heading text-[11px] font-semibold text-accent underline-offset-2 hover:underline"
                >
                  {showAdvanced ? "Hide advanced" : "Advanced"}
                </button>
                {showAdvanced ? (
                  <div className="mt-1 space-y-1 rounded-lg border border-ink/15 bg-background px-2 py-1.5">
                    <p className="break-all font-mono text-[11px] leading-snug text-ink/55">
                      {step.targetHint}
                    </p>
                    {model && anyAdvancedOpen ? (
                      <p className="font-mono text-[10px] text-ink/40">
                        model: {model}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        onClick={onRecord}
        className="stamp-button font-heading -rotate-1"
      >
        Record
      </button>
      <p className="text-center text-[12px] text-ink/45">
        We film the live site, cut a tight ~30s reel, and give you an MP4 for 6
        hours.
      </p>
      <button
        type="button"
        onClick={onBack}
        className="font-heading text-sm font-semibold text-ink/60 underline-offset-2 hover:underline"
      >
        Back
      </button>
    </div>
  );
}
