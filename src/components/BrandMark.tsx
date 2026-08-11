"use client";

import Image from "next/image";
import { motion, useReducedMotion } from "framer-motion";

type Props = {
  className?: string;
};

/**
 * Header brand: real logo badge + DemoBro wordmark.
 * Peel & settle entrance + light hover wiggle (option A).
 * JPG white plate: mix-blend multiply into #FAF9F6.
 */
export function BrandMark({ className = "" }: Props) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.h1
      className={`flex cursor-default items-center gap-2 font-heading font-bold leading-none tracking-tight text-ink ${className}`}
      style={{ transformOrigin: "left center" }}
      initial={
        reduceMotion ? false : { opacity: 0, y: -16, rotate: -14, scale: 0.9 }
      }
      animate="rest"
      variants={{
        rest: { opacity: 1, y: 0, rotate: -6, scale: 1 },
        hover: reduceMotion
          ? { opacity: 1, y: 0, rotate: -6, scale: 1 }
          : {
              opacity: 1,
              y: 0,
              scale: 1,
              rotate: [-6, -3.5, -8.5, -5, -6],
              transition: { duration: 0.45, ease: "easeInOut" },
            },
      }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { type: "spring", stiffness: 380, damping: 16, mass: 0.75 }
      }
      whileHover="hover"
    >
      <Image
        src="/brand/demobro-logo.png"
        alt=""
        width={64}
        height={64}
        priority
        className="brand-logo h-[1.05em] w-[1.05em] shrink-0 select-none object-contain"
        aria-hidden
      />
      <span className="whitespace-nowrap">
        Demo
        <motion.span
          className="inline-block text-accent"
          variants={{
            rest: { scale: 1 },
            hover: reduceMotion
              ? { scale: 1 }
              : {
                  scale: 1.07,
                  transition: { type: "spring", stiffness: 520, damping: 16 },
                },
          }}
        >
          Bro
        </motion.span>
      </span>
    </motion.h1>
  );
}
