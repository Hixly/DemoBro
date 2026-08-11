import { NextResponse, type NextRequest } from "next/server";
import {
  BETA_COOKIE_NAME,
  betaGateEnabled,
  validBetaCookie,
} from "@/lib/beta-auth";

export async function middleware(request: NextRequest) {
  if (!betaGateEnabled()) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (pathname === "/beta" || pathname === "/api/beta-access") {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(BETA_COOKIE_NAME)?.value;
  if (await validBetaCookie(cookie)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Private beta access is required." },
      { status: 401 },
    );
  }

  const gateUrl = new URL("/beta", request.url);
  return NextResponse.redirect(gateUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|brand/|api/beta-access).*)",
  ],
};
