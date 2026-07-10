// Mirror of backend common/slug.ts — lowercase letters/digits/dot/hyphen, must start with a
// letter and must not end with a dot or hyphen.
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
      .replace(/^-+|-+$/g, "") || ""
  );
}
