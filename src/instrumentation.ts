export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.DATABASE_URL) return;

  try {
    const { resumePendingJobs } = await import("@/lib/jobs/process");
    await resumePendingJobs();
  } catch (error) {
    console.error("[jobs] resume on boot failed", error);
  }
}
