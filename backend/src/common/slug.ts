// Workspace handle rules (also the inbound-email prefix and KB URL segment):
// lowercase letters/digits/dot/hyphen; must start with a letter (so never a digit,
// dot or hyphen) and must end with a letter or digit (so never a dot or hyphen).
export const SLUG_REGEX = /^[a-z](?:[a-z0-9.-]*[a-z0-9])?$/;

export function isValidSlug(input: string): boolean {
  return SLUG_REGEX.test(input);
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace"
  );
}

export function randomSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 4);
}
