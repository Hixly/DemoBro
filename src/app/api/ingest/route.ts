import { NextResponse } from "next/server";
import { ingestGithubRepo } from "@/lib/github";
import { validateGithubUrl } from "@/lib/validate";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Expected JSON body with githubUrl." },
      { status: 400 },
    );
  }

  const githubUrl =
    typeof body === "object" &&
    body !== null &&
    "githubUrl" in body &&
    typeof (body as { githubUrl: unknown }).githubUrl === "string"
      ? (body as { githubUrl: string }).githubUrl
      : "";

  const validationError = validateGithubUrl(githubUrl);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const result = await ingestGithubRepo(githubUrl);
  return NextResponse.json(result);
}
