import { NextResponse } from "next/server";
import { ingestGithubRepo } from "@/lib/github";
import { inferLivePageMetadata } from "@/lib/live-metadata";
import { validateGithubUrl, validateLiveUrl } from "@/lib/validate";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Expected JSON body with liveUrl and optional githubUrl." },
      { status: 400 },
    );
  }

  const payload =
    typeof body === "object" && body !== null
      ? (body as { liveUrl?: unknown; githubUrl?: unknown })
      : {};
  const liveUrl = typeof payload.liveUrl === "string" ? payload.liveUrl.trim() : "";
  const githubUrl =
    typeof payload.githubUrl === "string" ? payload.githubUrl.trim() : "";

  const liveError = validateLiveUrl(liveUrl);
  const githubError = validateGithubUrl(githubUrl);
  if (liveError || githubError) {
    return NextResponse.json(
      { error: liveError ?? githubError },
      { status: 400 },
    );
  }

  try {
    const [live, repo] = await Promise.all([
      inferLivePageMetadata(liveUrl),
      githubUrl
        ? ingestGithubRepo(githubUrl).catch((error) => {
            console.warn(
              "[ingest] optional GitHub context unavailable:",
              error instanceof Error ? error.message : error,
            );
            return null;
          })
        : Promise.resolve(null),
    ]);

    if (repo?.status === "ok") {
      return NextResponse.json({
        status: "ok",
        source: "github",
        repoStatus: "public",
        repoUrl: githubUrl,
        title: repo.title,
        description: repo.description,
        badges: repo.badges,
      });
    }

    return NextResponse.json({
      status: "ok",
      source: "live",
      repoStatus: repo?.reason ?? (githubUrl ? "unavailable" : "not_provided"),
      repoUrl: "",
      message: repo
        ? "That repository was not publicly readable, so DemoBro used the live page instead."
        : "DemoBro used the live page for project context.",
      title: live.title,
      description: live.description,
      badges: live.badges,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not read that project.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
