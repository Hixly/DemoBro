import type { Metadata } from "next";
import { BetaGate } from "@/components/BetaGate";

export const metadata: Metadata = {
  title: "Private Beta | DemoBro",
  description: "Enter the DemoBro private beta.",
  robots: { index: false, follow: false },
};

export default function BetaPage() {
  return <BetaGate />;
}
