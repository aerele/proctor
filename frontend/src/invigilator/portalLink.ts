// frontend/src/invigilator/portalLink.ts
//
// S-D invigilator token entry (vision I1 + §2.7): the contest detail page
// derives /invigilator?contest={slug}&key={invigilator_key} links. The key
// authenticates THAT contest only — the backend compares it against the
// resolved contest doc (timing-safe) and never the legacy portal, so a key
// without a contest is meaningless and dropped here. The typed-password
// fallback (global INVIGILATOR_PASSWORD / admin) stays available.

export type PortalLink = { contest: string; key: string };

/** The ?contest= and ?key= of the /invigilator URL ("" when absent). */
export function portalLinkOf(search: string): PortalLink {
  const params = new URLSearchParams(search);
  const contest = params.get("contest")?.trim() ?? "";
  const key = params.get("key")?.trim() ?? "";
  // A key never authenticates the legacy (no-contest) portal — drop it.
  if (!contest) return { contest: "", key: "" };
  return { contest, key };
}

/**
 * What rides x-invigilator-password: a typed password always wins (it is the
 * fallback after a stale/regenerated key is rejected); otherwise the link key.
 */
export function portalCredential(link: PortalLink, typedPassword: string): string {
  return typedPassword || link.key;
}
