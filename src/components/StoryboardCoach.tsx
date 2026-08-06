"use client";

import Image from "next/image";
import type { CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

type Props = {
  tip: string;
  /** Desktop: side gutter beside a step. Mobile: stacked above the list. */
  layout: "gutter" | "stack";
};

type Direction = "right" | "down";

/**
 * 9-slice Sharpie ring — evenodd outer/inner path so corners + edges
 * stretch cleanly via border-image (not a fixed-aspect bubble path).
 */
const SHARPIE_BORDER_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <path fill="#141414" fill-rule="evenodd" d="
      M9 5c10-2.5 36-2.5 46 .8 4 1.4 5.5 7 5.5 13.2v26c0 6.2-2 12-6.2 13.8-10 2.8-35 2.5-45.5-.5C5 56 3.5 50 3.5 44V19C3.5 12 5.5 7 9 5z
      M13.5 11.5c8-1.8 29-1.8 37 .4 2.5.8 3.5 4.5 3.5 9.1v22c0 4.6-1.2 8.2-4 9.2-8 2-28 1.8-36.5-.3-2.2-.7-3.5-4-3.5-8.5v-23c0-4.2 1.2-7.5 3.5-8.9z
    "/>
  </svg>`,
);

const sharpieOutline: CSSProperties = {
  borderStyle: "solid",
  borderColor: "transparent",
  borderWidth: 12,
  borderImageSource: `url("data:image/svg+xml,${SHARPIE_BORDER_SVG}")`,
  borderImageSlice: 14,
  borderImageWidth: 12,
  borderImageRepeat: "stretch",
};

function BubbleBeak({ direction }: { direction: Direction }) {
  if (direction === "right") {
    return (
      <svg
        className="pointer-events-none absolute top-1/2 right-0 z-20 h-7 w-[18px] -translate-y-1/2 translate-x-[11px] overflow-visible"
        viewBox="0 0 18 28"
        aria-hidden
      >
        <path
          d="M1 5 L15 14 L1 23 Z"
          fill="var(--accent)"
          transform="translate(1.5 1.5)"
        />
        <path
          d="M0 5 L14 14 L0 23 Z"
          fill="#ffffff"
          stroke="var(--ink)"
          strokeWidth="2.25"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Tuck into the bubble edge so the join reads continuous */}
        <path d="M1 9 V19" stroke="#ffffff" strokeWidth="5" />
      </svg>
    );
  }

  return (
    <svg
      className="pointer-events-none absolute bottom-0 left-1/2 z-20 h-[18px] w-7 -translate-x-1/2 translate-y-[11px] overflow-visible"
      viewBox="0 0 28 18"
      aria-hidden
    >
      <path
        d="M5 1 L14 15 L23 1 Z"
        fill="var(--accent)"
        transform="translate(1.5 1.5)"
      />
      <path
        d="M5 0 L14 14 L23 0 Z"
        fill="#ffffff"
        stroke="var(--ink)"
        strokeWidth="2.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d="M9 1 H19" stroke="#ffffff" strokeWidth="5" />
    </svg>
  );
}

/**
 * Content-sized bubble: HTML box grows with tip text + ≥16px padding.
 * Outline is a stretching 9-slice Sharpie border-image; beak is separate.
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
      {/* Hard accent offset — tracks the content box */}
      <div
        aria-hidden
        className="absolute inset-0 translate-x-[3px] translate-y-[3px] bg-accent"
        style={{ borderRadius: 18 }}
      />

      <div
        className="relative bg-white"
        style={{
          ...sharpieOutline,
          // ≥16px from text to the ink stroke (stroke lives in the border box)
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 16,
          // Extra on the beak side so words never meet the tail
          paddingRight: direction === "right" ? 18 : 16,
          ...(direction === "down" ? { paddingBottom: 18 } : null),
        }}
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
