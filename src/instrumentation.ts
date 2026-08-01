export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.DATABASE_URL) return;

  try {
    const { runJobWorkerLoop } = await import("@/lib/jobs/process");

    // Single awaited worker loop — fire-and-forget + after() were dropping work
    // on Railway before processJob could mark jobs running.
    const g = globalThis as unknown as { __scriptAssemblerJobWorker?: boolean };
    if (!g.__scriptAssemblerJobWorker) {
      g.__scriptAssemblerJobWorker = true;
      console.log("[jobs] instrumentation register — starting job worker loop");
      void runJobWorkerLoop().catch((error) => {
        console.error("[jobs] worker loop crashed", error);
      });
    }
  } catch (error) {
    console.error("[jobs] worker boot failed", error);
  }
}
