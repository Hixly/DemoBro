import { NextResponse } from "next/server";
import {
  BETA_COOKIE_NAME,
  betaGateEnabled,
  betaPassword,
  createBetaAccessToken,
  validBetaPassword,
} from "@/lib/beta-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!betaGateEnabled()) {
    return NextResponse.json({ ok: true });
  }

  if (!betaPassword()) {
    return NextResponse.json(
      { error: "The private beta key has not been configured yet." },
      { status: 503 },
    );
  }

  let accessKey = "";
  try {
    const body = (await request.json()) as { accessKey?: unknown };
    accessKey = typeof body.accessKey === "string" ? body.accessKey.trim() : "";
  } catch {
    return NextResponse.json({ error: "Enter today’s access key." }, { status: 400 });
  }

  if (!(await validBetaPassword(accessKey))) {
    return NextResponse.json(
      { error: "That key didn’t make today’s guest list. Check it and try again." },
      { status: 401 },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: BETA_COOKIE_NAME,
    value: await createBetaAccessToken(betaPassword()),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  return response;
}
