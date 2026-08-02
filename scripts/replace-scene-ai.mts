/**
 * One-shot: replace a scene still with AI and rebuild the package.
 *
 *   railway run --service script-assembler npx tsx scripts/replace-scene-ai.mts \
 *     --job cmsbyf1sd0000od2um2avhqir --scene 6 \
 *     --idea "evil AI machine vision flagging anomalies on dark deep-water ROV feed"
 */
import { replaceSceneWithAi } from "../src/lib/jobs/replaceSceneAi";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}

async function main() {
  const jobId = arg("job");
  const sceneRef = arg("scene");
  const visualIdea = arg(
    "idea",
    "ominous evil AI system — dark machine-vision interface and cold server racks watching a deep underwater ROV video feed, no people, no readable text, documentary tension",
  );
  const subject = arg("subject", "evil AI");
  const why = arg("why", "AI still · evil AI machine vision");

  console.log(`Replacing job=${jobId} scene=${sceneRef}`);
  console.log(`idea=${visualIdea}`);

  const result = await replaceSceneWithAi({
    jobId,
    sceneRef,
    visualIdea,
    subject,
    why,
    repackage: "patch",
  });

  console.log(
    JSON.stringify(
      {
        packageReady: result.packageReady,
        sceneId: result.scene.sceneId,
        visualSource: result.scene.visualSource,
        subject: result.scene.subject,
        why: result.scene.why,
        imageUrl: result.scene.imageUrl,
        r2Url: result.scene.r2Url,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
