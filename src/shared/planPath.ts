/** Slugify a string for use as a filename. */
export function slugify(s: string): string {
  return (
    String(s || "plan")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") // remove trailing dashes after truncation
      || "plan"
  );
}


export const planRelativePath = (title: string) => `.plans/${slugify(title)}.md`;
