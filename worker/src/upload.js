import { readFile, stat } from "node:fs/promises";
import {
  DIAGNOSTICS_BUCKET,
  getSupabaseAdmin,
  STORAGE_BUCKET,
  VIDEO_TTL_SECONDS,
} from "./supabase.js";

const DIAGNOSTIC_CONTENT_TYPES = {
  ".zip": "application/zip",
  ".json": "application/json",
};

/**
 * Upload finished MP4 to the existing Storage bucket and return a 6h signed URL.
 * @param {{ localPath: string, objectPath: string }} opts
 */
export async function uploadFinishedMp4(opts) {
  const supabase = getSupabaseAdmin();
  const bytes = await readFile(opts.localPath);
  const info = await stat(opts.localPath);

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(opts.objectPath, bytes, {
      contentType: "video/mp4",
      upsert: true,
      cacheControl: "3600",
    });

  if (uploadError) {
    throw new Error(`Storage upload failed: ${uploadError.message}`);
  }

  const { data, error: signError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(opts.objectPath, VIDEO_TTL_SECONDS);

  if (signError || !data?.signedUrl) {
    throw new Error(
      `Signed URL failed: ${signError?.message ?? "no url returned"}`,
    );
  }

  return {
    bucket: STORAGE_BUCKET,
    objectPath: opts.objectPath,
    signedUrl: data.signedUrl,
    bytes: info.size,
    expiresInSec: VIDEO_TTL_SECONDS,
  };
}

/**
 * Preserve private support evidence for failed or low-confidence jobs.
 * Raw video is intentionally excluded; traces + structured review are enough
 * to debug the browser path without publishing another copy of the footage.
 */
export async function uploadDiagnosticBundle({ jobId, files = [], manifest }) {
  const supabase = getSupabaseAdmin();
  const { data: bucket, error: bucketError } = await supabase.storage.getBucket(
    DIAGNOSTICS_BUCKET,
  );
  if (bucketError) {
    throw new Error(`Diagnostics bucket unavailable: ${bucketError.message}`);
  }
  if (bucket?.public) {
    throw new Error("Diagnostics bucket must remain private.");
  }

  const uploaded = [];
  for (const file of files.filter(Boolean)) {
    try {
      const bytes = await readFile(file);
      const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
      const name = file.replace(/\\/g, "/").split("/").pop();
      const objectPath = `${jobId}/${name}`;
      const { error } = await supabase.storage
        .from(DIAGNOSTICS_BUCKET)
        .upload(objectPath, bytes, {
          contentType:
            DIAGNOSTIC_CONTENT_TYPES[extension] || "application/octet-stream",
          upsert: true,
          cacheControl: "0",
        });
      if (error) throw error;
      uploaded.push(objectPath);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw new Error(
        `Diagnostic upload failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (manifest) {
    const objectPath = `${jobId}/manifest.json`;
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    const { error } = await supabase.storage
      .from(DIAGNOSTICS_BUCKET)
      .upload(objectPath, bytes, {
        contentType: "application/json",
        upsert: true,
        cacheControl: "0",
      });
    if (error) {
      throw new Error(`Diagnostic manifest upload failed: ${error.message}`);
    }
    uploaded.push(objectPath);
  }

  return { bucket: DIAGNOSTICS_BUCKET, paths: uploaded };
}

/**
 * Mark job ready with storage path + 6h expiry.
 */
export async function markJobReady(jobId, { objectPath, bytes }) {
  const supabase = getSupabaseAdmin();
  const expiresAt = new Date(Date.now() + VIDEO_TTL_SECONDS * 1000).toISOString();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("jobs")
    .update({
      status: "ready",
      stage: "ready",
      output_path: objectPath,
      bytes_stored: bytes,
      error_message: null,
      expires_at: expiresAt,
      updated_at: now,
    })
    .eq("id", jobId);

  if (error) throw new Error(`Failed to mark job ready: ${error.message}`);
  return { expiresAt };
}

export async function markJobStatus(jobId, status, stage, extra = {}) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("jobs")
    .update({
      status,
      stage,
      updated_at: new Date().toISOString(),
      ...extra,
    })
    .eq("id", jobId);

  if (error) {
    throw new Error(`Failed to update job status: ${error.message}`);
  }
}

/**
 * Fail jobs whose worker died or was redeployed mid-run. Without this a claimed
 * job keeps its in-progress status forever and the browser spins indefinitely.
 * @param {number} olderThanMs
 * @returns {Promise<string[]>} ids that were swept
 */
export async function reapStaleJobs(olderThanMs) {
  const supabase = getSupabaseAdmin();
  const now = Date.now();
  const { data, error } = await supabase
    .from("jobs")
    .update({
      status: "failed",
      stage: "failed",
      error_message: "This demo stalled and was stopped. Please try again.",
      updated_at: new Date(now).toISOString(),
      expires_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
    })
    .in("status", ["recording", "rendering"])
    .lt("claimed_at", new Date(now - olderThanMs).toISOString())
    .select("id");

  if (error) throw new Error(`Stale sweep failed: ${error.message}`);
  return (data ?? []).map((row) => row.id);
}

/**
 * Claim the oldest queued job (single-row UPDATE … RETURNING via filter).
 */
export async function claimNextJob(workerId) {
  const supabase = getSupabaseAdmin();
  const { data: queued, error: listError } = await supabase
    .from("jobs")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);

  if (listError) throw new Error(`Claim list failed: ${listError.message}`);
  const id = queued?.[0]?.id;
  if (!id) return null;

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("jobs")
    .update({
      status: "recording",
      stage: "touring_app",
      claimed_at: now,
      claimed_by: workerId,
      updated_at: now,
    })
    .eq("id", id)
    .eq("status", "queued")
    .select(
      "id, live_url, repo_url, title, description, stack_badges, storyboard, status, stage",
    )
    .maybeSingle();

  if (error) throw new Error(`Claim update failed: ${error.message}`);
  return data;
}
