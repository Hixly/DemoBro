import { NextResponse } from "next/server";
import { getJob, signedVideoUrl } from "@/lib/jobs";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
  }

  try {
    const job = await getJob(id);
    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    let videoUrl: string | null = null;
    if (job.status === "ready" && job.output_path) {
      if (job.expires_at && Date.parse(job.expires_at) < Date.now()) {
        return NextResponse.json({
          id: job.id,
          status: "expired",
          stage: "expired",
          title: job.title,
          error: "This video link has expired.",
          videoUrl: null,
          expiresAt: job.expires_at,
        });
      }
      videoUrl = await signedVideoUrl(job.output_path);
    }

    return NextResponse.json({
      id: job.id,
      status: job.status,
      stage: job.stage,
      title: job.title,
      description: job.description,
      badges: job.stack_badges,
      error: job.error_message,
      videoUrl,
      expiresAt: job.expires_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not load job.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
