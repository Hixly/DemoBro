import type { ElementType, ReactNode } from "react";

type Props = {
  children: ReactNode;
  className?: string;
  /** Inner fill / padding / type styles */
  innerClassName?: string;
  as?: ElementType;
};

/**
 * Same chrome as the storyboard coach speech bubble:
 * hard accent offset stamp + ink Sharpie SVG outline (not a CSS border).
 * Stroke matches the bubble beak: var(--ink), ~2px, round joins.
 *
 * Uses divs (not spans) so block children like <p> don't break the chrome.
 */
export function StampSharpie({
  children,
  className = "",
  innerClassName = "",
  as: Tag = "div",
}: Props) {
  return (
    <Tag className={`relative ${className}`}>
      {/* Hard offset shadow — same 3×3 accent block as the coach bubble */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 translate-x-[3px] translate-y-[3px] rounded-xl bg-accent"
      />
      <div className={`relative rounded-xl ${innerClassName}`}>
        {children}
        {/*
          Hand-drawn ink outline — slightly imperfect path, same stroke
          treatment as StoryboardCoach beak (ink / 2px / round).
          preserveAspectRatio=none so it wraps any size.
        */}
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path
            d="M 10 3
               C 28 0.5 55 1 78 2.5
               C 90 3.5 97 10 98 22
               C 99.5 40 99 60 97.5 78
               C 96.5 90 88 97 74 98
               C 52 99.5 30 99 16 96.5
               C 7 94.5 2.5 86 2 72
               C 1 52 1.5 32 3 18
               C 4 9 6.5 4.5 10 3 Z"
            fill="none"
            stroke="var(--ink)"
            strokeWidth="2.25"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </Tag>
  );
}
