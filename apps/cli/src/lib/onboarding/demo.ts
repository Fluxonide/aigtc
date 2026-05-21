// ==============================================================================
// POST-SETUP PROMPT
// Minimal post-setup experience.
// ==============================================================================

import { confirm, isCancel } from "@clack/prompts";

/**
 * Ask if user wants to try AIGTC now.
 * Returns true if user wants to continue, false if they want to exit.
 */
export async function askTryNow(): Promise<boolean> {
  const tryNow = await confirm({
    message: "Run aigtc now?",
    initialValue: true,
  });

  if (isCancel(tryNow) || !tryNow) {
    return false;
  }

  return true;
}
