import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "inbox";

async function main() {
  console.log("[demobro-cron] cleanup starting");
  if (!url || !key) {
    console.log("[demobro-cron] missing Supabase env — exiting");
    process.exit(0);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date().toISOString();
  const { data: expired, error } = await supabase
    .from("jobs")
    .select("id, output_path")
    .not("expires_at", "is", null)
    .lt("expires_at", now)
    .limit(50);

  if (error) {
    console.error("[demobro-cron] query failed:", error.message);
    process.exit(1);
  }

  let removed = 0;
  for (const job of expired ?? []) {
    if (job.output_path) {
      const { error: rmError } = await supabase.storage
        .from(bucket)
        .remove([job.output_path]);
      if (rmError) {
        console.warn(`[demobro-cron] storage remove ${job.id}: ${rmError.message}`);
      }
    }
    const { error: delError } = await supabase.from("jobs").delete().eq("id", job.id);
    if (delError) {
      console.warn(`[demobro-cron] job delete ${job.id}: ${delError.message}`);
    } else {
      removed += 1;
    }
  }

  console.log(`[demobro-cron] swept ${removed} expired job(s)`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[demobro-cron] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
