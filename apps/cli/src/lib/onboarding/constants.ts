// ==============================================================================
// ONBOARDING CONSTANTS
// Imports from @aigtc/meta for consistency. Re-exports for local convenience.
// ==============================================================================

import { ERROR_TEMPLATES, PROVIDERS, isCLIProviderDoc } from "@aigtc/meta";

/**
 * Installation information for CLI tools.
 * Derived from @aigtc/meta provider docs.
 *
 * Note: PROVIDERS in @aigtc/meta and the runtime registry in
 * providers/registry.ts must be kept in sync when adding/removing providers.
 */
export function getInstallInfo(providerId: string) {
  const doc = PROVIDERS[providerId];
  if (!doc || !isCLIProviderDoc(doc)) return undefined;
  return {
    name: doc.name,
    binary: doc.binary,
    installCommand: doc.installCommand,
    docsUrl: doc.docsUrl,
  };
}

/**
 * Error message templates. Re-exported from @aigtc/meta under the legacy
 * name `ERROR_MESSAGES` to avoid renaming all consumer call sites.
 * Canonical name is `ERROR_TEMPLATES` in @aigtc/meta.
 */
export { ERROR_TEMPLATES as ERROR_MESSAGES };
