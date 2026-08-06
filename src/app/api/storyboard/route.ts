import { NextResponse } from "next/server";
import { ingestGithubRepo, type RepoIngestOk } from "@/lib/github";
import { generateStoryboard } from "@/lib/storyboard";
import { validateGithubUrl, validateLiveUrl } from "@/lib/validate";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  liveUrl?: string;
  githubUrl?: string;
  /** Optional override when GitHub ingest fell back */
  manualTitle?: string;
  manualDescription?: string;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: "Expected JSON with liveUrl and githubUrl." },
      { status: 400 },
    );
  }

  const liveUrl = typeof body.liveUrl === "string" ? body.liveUrl.trim() : "";
  const githubUrl =
    typeof body.githubUrl === "string" ? body.githubUrl.trim() : "";

  const liveError = validateLiveUrl(liveUrl);
  if (liveError) {
    return NextResponse.json({ error: liveError }, { status: 400 });
  }

  const githubError = validateGithubUrl(githubUrl);
  if (githubError) {
    return NextResponse.json({ error: githubError }, { status: 400 });
  }

  try {
    const ingest = await ingestGithubRepo(githubUrl);

    let repo: Pick<RepoIngestOk, "title" | "description" | "badges" | "raw">;
    if (ingest.status === "ok") {
      repo = ingest;
    } else {
      const title =
        typeof body.manualTitle === "string" && body.manualTitle.trim()
          ? body.manualTitle.trim()
          : ingest.suggestedTitle;
      repo = {
        title,
        description:
          typeof body.manualDescription === "string" &&
          body.manualDescription.trim()
            ? body.manualDescription.trim()
            : "A web app demo.",
        badges: [],
        raw: {
          name: ingest.repo ?? title,
          description: null,
          homepage: null,
          defaultBranch: "main",
          readmeExcerpt: "",
          languages: {},
          packageJson: null,
          treePaths: [],
        },
      };
    }

    const storyboard = await generateStoryboard({ liveUrl, repo });
    return NextResponse.json({
      status: "ok",
      ingestStatus: ingest.status,
      title: repo.title,
      description: repo.description,
      badges: repo.badges,
      storyboard,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Storyboard generation failed.";
    const status = /XAI_API_KEY/.test(message) ? 503 : 502;
    console.error("[storyboard]", message);
    return NextResponse.json({ error: message }, { status });
  }
}
