/**
 * Nightly consolidation job — runs at 2am via node-cron.
 * - Promotes rules with >10 observations and >0.8 confidence
 * - Demotes rules with >3 corrections in last 7 days
 * - Prunes rules with 0 observations in 30 days
 * - Re-runs Claude over last 7 days of screenpipe data
 */

import {
  promoteHighConfidenceRules,
  demoteFrequentlyCorrectRules,
  pruneStaleRules,
} from "./db";
import { runExtractionJob } from "./extractor";

export async function runNightlyConsolidation(): Promise<void> {
  console.log("[consolidation] Starting nightly consolidation …");

  const promoted = promoteHighConfidenceRules();
  console.log(`[consolidation] Promoted ${promoted} rules to higher confidence.`);

  const demoted = demoteFrequentlyCorrectRules();
  console.log(`[consolidation] Demoted ${demoted} frequently-corrected rules.`);

  const pruned = pruneStaleRules();
  console.log(`[consolidation] Pruned ${pruned} stale rules.`);

  // Re-run extraction over the last 7 days
  console.log("[consolidation] Re-running extraction over last 7 days …");
  await runExtractionJob();

  console.log("[consolidation] Nightly consolidation complete.");
}
