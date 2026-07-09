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
