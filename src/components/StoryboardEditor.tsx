"use client";

import type { StoryboardStep } from "@/lib/storyboard";

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
  function move(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= steps.length) return;
    const copy = [...steps];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    onChange(copy);
  }

  function remove(index: number) {
    if (steps.length <= 1) return;
    onChange(steps.filter((_, i) => i !== index));
  }

  function editDescription(index: number, descriptionValue: string) {
    onChange(
      steps.map((step, i) =>
        i === index ? { ...step, description: descriptionValue } : step,
      ),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="font-heading text-[15px] font-semibold leading-snug text-ink -rotate-1 origin-left">
        Tour storyboard
      </p>

      <div className="rounded-xl border-2 border-ink bg-background p-3 -rotate-1">
        <p className="font-heading text-lg font-bold text-ink">{title}</p>
        <p className="mt-1 text-sm leading-snug text-ink/70">{description}</p>
        {badges.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {badges.map((badge) => (
              <span key={badge} className="stamp-badge font-heading">
                {badge}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className="rounded-xl border-2 border-ink bg-white p-3 shadow-[3px_3px_0_var(--accent)]"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-heading text-sm font-bold text-ink">
                Step {index + 1}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  aria-label="Move step up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  className="rounded-md border-2 border-ink px-2 py-0.5 font-mono text-xs disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label="Move step down"
                  disabled={index === steps.length - 1}
                  onClick={() => move(index, 1)}
                  className="rounded-md border-2 border-ink px-2 py-0.5 font-mono text-xs disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label="Delete step"
                  disabled={steps.length <= 1}
                  onClick={() => remove(index)}
                  className="rounded-md border-2 border-danger px-2 py-0.5 font-mono text-xs text-danger disabled:opacity-30"
                >
                  ✕
                </button>
              </div>
            </div>

            <label className="flex flex-col gap-1">
              <span className="font-heading text-xs font-semibold text-ink/70">
                Description
              </span>
              <textarea
                value={step.description}
                onChange={(e) => editDescription(index, e.target.value)}
                rows={2}
                className="stamp-input font-heading text-sm"
              />
            </label>

            <p className="mt-2 break-all font-mono text-[11px] leading-snug text-ink/55">
              target: {step.targetHint}
            </p>
          </li>
        ))}
      </ol>

      {model ? (
        <p className="font-mono text-[11px] text-ink/40">model: {model}</p>
      ) : null}

      <button
        type="button"
        onClick={onRecord}
        className="stamp-button font-heading -rotate-1"
      >
        Record
      </button>
      <p className="text-center text-[12px] text-ink/45">
        We film the live site, cut a tight ~30s reel, and give you an MP4 for 6 hours.
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
