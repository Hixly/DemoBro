import type { Metadata } from "next";
import { Fredoka, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const fredoka = Fredoka({
  subsets: ["latin"],
  variable: "--font-fredoka",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.demobro.video"),
  title: "DemoBro",
  description:
    "Generate a polished ~30-second demo video of your web app — no screen recording.",
  openGraph: {
    title: "DemoBro — Drop your links. We film the tour.",
    description:
      "Generate a polished micro-demo from your live app—no screen recording required.",
    url: "/",
    siteName: "DemoBro",
    type: "website",
    images: [
      {
        url: "/brand/demobro-social-card.png",
        width: 1200,
        height: 630,
        alt: "DemoBro — Drop your links. We film the tour.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "DemoBro — Drop your links. We film the tour.",
    description:
      "Generate a polished micro-demo from your live app—no screen recording required.",
    images: ["/brand/demobro-social-card.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${fredoka.variable} ${plexMono.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
