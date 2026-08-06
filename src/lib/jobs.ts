import { createHmac, randomUUID } from "node:crypto";
import {
  getSupabaseAdmin,
  STORAGE_BUCKET,
  VIDEO_TTL_SECONDS,
} from "@/lib/supabase";
import type { StoryboardStep } from "@/lib/storyboard";

export type JobStatus =
  | "queued"
  | "recording"
  | "rendering"
  | "ready"
  | "failed";

export type JobRow = {
  id: string;
  live_url: string;
  repo_url: string;
  title: string;
  description: string;
  stack_badges: string[];
  storyboard: { steps: StoryboardStep[] };
  status: JobStatus;
  stage: string | null;
  output_path: string | null;
  error_message: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export function hashIp(ip: string): string {
  const secret =
    process.env.IP_HASH_SECRET?.trim() ||
    process.env.DEMOBRO_IP_HASH_SECRET?.trim() ||
    "demobro-dev-ip-hash";
  return createHmac("sha256", secret).update(ip).digest("hex");
}

export async function createJob(input: {
  liveUrl: string;
  repoUrl: string;
  title: string;
  description: string;
  badges: string[];
  steps: StoryboardStep[];
  ip: string;
}): Promise<JobRow> {
  const supabase = getSupabaseAdmin();
  const id = randomUUID();
  const now = new Date().toISOString();

  const row = {
    id,
    ip_hash: hashIp(input.ip),
    live_url: input.liveUrl,
    repo_url: input.repoUrl,
    title: input.title,
    description: input.description,
    stack_badges: input.badges,
    storyboard: { steps: input.steps },
    status: "queued" as const,
    stage: "queued",
    output_path: null,
    error_message: null,
    created_at: now,
    updated_at: now,
    expires_at: null,
  };

  const { data, error } = await supabase
    .from("jobs")
    .insert(row)
    .select(
      "id, live_url, repo_url, title, description, stack_badges, storyboard, status, stage, output_path, error_message, expires_at, created_at, updated_at",
    )
    .single();

  if (error) throw new Error(`Failed to create job: ${error.message}`);
  return data as JobRow;
}

export async function getJob(id: string): Promise<JobRow | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("jobs")
    .select(
      "id, live_url, repo_url, title, description, stack_badges, storyboard, status, stage, output_path, error_message, expires_at, created_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Failed to load job: ${error.message}`);
  return (data as JobRow | null) ?? null;
}

export async function signedVideoUrl(
  outputPath: string,
): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(outputPath, VIDEO_TTL_SECONDS);

  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
