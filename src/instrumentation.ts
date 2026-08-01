export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.DATABASE_URL) return;

  try {
    const { resumePendingJobs } = await import("@/lib/jobs/process");

    console.log("[jobs] instrumentation register — resuming pending jobs");
    await resumePendingJobs();

    // Durable poller: Next request lifecycle can drop fire-and-forget work.
    // This keeps queued jobs moving on Railway's long-lived Node process.
    const g = globalThis as unknown as { __scriptAssemblerJobPoller?: boolean };
    if (!g.__scriptAssemblerJobPoller) {
      g.__scriptAssemblerJobPoller = true;
      setInterval(() => {
        void resumePendingJobs().catch((err) => {
          console.error("[jobs] poller resume failed", err);
        });
      }, 10_000);
      console.log("[jobs] poller started (every 10s)");
    }
  } catch (error) {
    console.error("[jobs] resume on boot failed", error);
  }
}
