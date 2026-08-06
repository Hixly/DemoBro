import { NextResponse } from "next/server";
import { createJob } from "@/lib/jobs";
import type { StoryboardStep } from "@/lib/storyboard";
import { validateGithubUrl, validateLiveUrl } from "@/lib/validate";

export const runtime = "nodejs";

type Body = {
  liveUrl?: string;
  githubUrl?: string;
  title?: string;
  description?: string;
  badges?: string[];
  steps?: StoryboardStep[];
};

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const liveUrl = body.liveUrl?.trim() ?? "";
  const githubUrl = body.githubUrl?.trim() ?? "";
  const liveError = validateLiveUrl(liveUrl);
  const githubError = validateGithubUrl(githubUrl);
  if (liveError || githubError) {
    return NextResponse.json(
      { error: liveError ?? githubError },
      { status: 400 },
    );
  }

  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (steps.length < 1) {
    return NextResponse.json(
      { error: "Storyboard needs at least one step." },
      { status: 400 },
    );
  }

  try {
    const job = await createJob({
      liveUrl,
      repoUrl: githubUrl,
      title: body.title?.trim() || "Untitled project",
      description: body.description?.trim() || "",
      badges: Array.isArray(body.badges) ? body.badges : [],
      steps,
      ip: clientIp(request),
    });

    return NextResponse.json({
      id: job.id,
      status: job.status,
      stage: job.stage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create job.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
