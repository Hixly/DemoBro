import { InputForm } from "@/components/InputForm";

export default function Home() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-16 sm:px-8">
      <h1 className="absolute left-5 top-8 font-heading text-[1.75rem] font-bold leading-none tracking-tight text-ink -rotate-6 sm:left-10 sm:top-12 sm:text-[2.15rem]">
        DemoBro<span className="text-accent">.video</span>
      </h1>

      <div className="stamp-badge absolute right-5 top-10 rotate-8 font-heading sm:right-12 sm:top-14">
        ~30s · no recording
      </div>

      <section className="stamp-card relative z-10 w-full max-w-[26rem] translate-x-2 rotate-[2.5deg] p-6 sm:translate-x-3 sm:p-7">
        <InputForm />
      </section>
    </main>
  );
}
