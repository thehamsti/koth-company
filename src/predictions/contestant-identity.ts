export function contestantIdentityFingerprint(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, " ")
    .trim();
}
