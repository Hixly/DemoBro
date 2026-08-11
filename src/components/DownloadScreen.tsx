"use client";

type Props = {
  title: string;
  videoUrl: string;
  onAnother: () => void;
};

export function DownloadScreen({ title, videoUrl, onAnother }: Props) {
  return (
    <div className="flex flex-col gap-4">
      <p className="font-heading text-[15px] font-semibold leading-snug text-ink -rotate-1 origin-left">
        Your demo is ready
      </p>

      <p className="font-heading text-lg font-bold text-ink">{title}</p>

      <video
        key={videoUrl}
        src={videoUrl}
        controls
        playsInline
        className="aspect-video w-full rounded-xl border-2 border-ink bg-black object-contain shadow-[4px_4px_0_var(--accent)] fullscreen:h-screen fullscreen:w-screen fullscreen:rounded-none fullscreen:border-0 fullscreen:shadow-none"
      />

      <a
        href={videoUrl}
        download={`${title.replace(/[^\w.-]+/g, "-").toLowerCase() || "demo"}.mp4`}
        className="stamp-button font-heading -rotate-1 text-center"
      >
        Download MP4
      </a>

      <p className="text-center text-[13px] leading-relaxed text-ink/55">
        your video is available for 6 hours.
      </p>

      <button
        type="button"
        onClick={onAnother}
        className="font-heading text-sm font-semibold text-ink/60 underline-offset-2 hover:underline"
      >
        Make another demo
      </button>
    </div>
  );
}
