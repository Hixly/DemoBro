import { BrandMark } from "@/components/BrandMark";
import { InputForm } from "@/components/InputForm";

export default function Home() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-x-hidden px-5 py-16 sm:px-8">
      <div className="absolute left-5 top-8 z-20 sm:left-10 sm:top-12">
        <BrandMark className="text-[1.75rem] sm:text-[2.15rem]" />
      </div>

      {/* InputForm owns its own card / wide storyboard shell */}
      <div className="relative z-10 w-full max-w-3xl">
        <InputForm />
      </div>
    </main>
  );
}
