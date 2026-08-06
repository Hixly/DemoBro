"use client";

import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

type Props = {
  tip: string;
  /** Desktop: side gutter beside a step. Mobile: stacked above the list. */
  layout: "gutter" | "stack";
};

type Direction = "right" | "down";

function BubbleBeak({ direction }: { direction: Direction }) {
  if (direction === "right") {
    return (
      <svg
        className="pointer-events-none absolute top-1/2 right-0 z-20 h-7 w-[17px] -translate-y-1/2 translate-x-[9px] overflow-visible"
        viewBox="0 0 17 28"
        aria-hidden
      >
        <path
          d="M1 5 L14 14 L1 23 Z"
          fill="var(--accent)"
          transform="translate(1.5 1.5)"
        />
        <path
          d="M0 5 L13 14 L0 23 Z"
          fill="#ffffff"
          stroke="var(--ink)"
          strokeWidth="2.25"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Cover the base so it reads as growing out of the bubble edge */}
        <path d="M0.5 9 V19" stroke="#ffffff" strokeWidth="5" />
      </svg>
    );
  }

  return (
    <svg
      className="pointer-events-none absolute bottom-0 left-1/2 z-20 h-[17px] w-7 -translate-x-1/2 translate-y-[9px] overflow-visible"
      viewBox="0 0 28 17"
      aria-hidden
    >
      <path
        d="M5 1 L14 14 L23 1 Z"
        fill="var(--accent)"
        transform="translate(1.5 1.5)"
      />
      <path
        d="M5 0 L14 13 L23 0 Z"
        fill="#ffffff"
        stroke="var(--ink)"
        strokeWidth="2.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d="M9 0.5 H19" stroke="#ffffff" strokeWidth="5" />
    </svg>
  );
}

/**
 * Content-sized bubble — the box grows with the tip.
 * Plain HTML layout (padding + wrap) so text can never escape the outline.
 * Ink border + accent stamp shadow; beak sits outside the text padding.
 */
function CoachBubble({
  tip,
  direction,
}: {
  tip: string;
  direction: Direction;
}) {
  return (
    <div className="relative w-full overflow-visible">
      {/* Hard accent offset */}
      <div
        aria-hidden
        className="absolute inset-0 translate-x-[3px] translate-y-[3px] rounded-xl bg-accent"
      />

      <div
        className={
          direction === "right"
            ? "relative rounded-xl border-2 border-ink bg-white p-4 pr-5"
            : "relative rounded-xl border-2 border-ink bg-white p-4 pb-5"
        }
      >
        <p className="font-heading text-[12px] font-semibold leading-snug text-ink">
          {tip}
        </p>
      </div>

      <BubbleBeak direction={direction} />
    </div>
  );
}

/**
 * Sticker coach — logo + comic speech bubble.
 * Desktop: beak on the right edge, aimed at the active step card.
 * Mobile: beak under the bubble, aimed at the list below.
 */
export function StoryboardCoach({ tip, layout }: Props) {
  const reduceMotion = useReducedMotion();
  const gutter = layout === "gutter";

  return (
    <motion.div
      layout={!reduceMotion}
      layoutId={reduceMotion ? undefined : "demobro-storyboard-coach"}
      className={
        gutter
          ? "relative flex w-[9.5rem] shrink-0 flex-col items-center gap-1 overflow-visible"
          : "relative mb-3 flex items-start gap-2"
      }
      initial={
        reduceMotion
          ? false
          : gutter
            ? { opacity: 0, scale: 0.9 }
            : { opacity: 0, y: -8, scale: 0.94 }
      }
      animate={{ opacity: 1, x: 0, y: 0, rotate: gutter ? -4 : 0, scale: 1 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { type: "spring", stiffness: 420, damping: 18, mass: 0.7 }
      }
    >
      <Image
        src="/brand/demobro-logo.png"
        alt=""
        width={64}
        height={64}
        className={`brand-logo shrink-0 select-none object-contain ${
          gutter ? "h-14 w-14 -rotate-6" : "h-11 w-11 rotate-[-4deg]"
        }`}
        aria-hidden
      />

      <div
        className={
          gutter
            ? "relative mt-1 w-full overflow-visible"
            : "relative min-w-0 flex-1 overflow-visible"
        }
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={tip}
            className="w-full"
            initial={
              reduceMotion ? { opacity: 1 } : { opacity: 0, y: 6, scale: 0.96 }
            }
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ type: "spring", stiffness: 400, damping: 22 }}
          >
            <CoachBubble tip={tip} direction={gutter ? "right" : "down"} />
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
