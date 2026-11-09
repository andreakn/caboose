// Telling a Jira key (or a link to an issue) from free text, where the user may type either.

/** "ABC-123" or ".../browse/ABC-123" as the whole input: the key; anything else (a summary that mentions a key too): null. */
export function parseKeyLike(text: string): string | null {
  const t = text.trim();
  const whole = /^([A-Za-z][A-Za-z0-9_]+-\d+)$/.exec(t)?.[1];
  if (whole) return whole.toUpperCase();
  const link = /^https?:\/\/\S+\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)\S*$/.exec(t)?.[1];
  return link ? link.toUpperCase() : null;
}

/** The Jira key a text starts with ("NWP-8259 Feature toggle…", "NWP-8259: …"), or null. */
export function leadingKey(text: string): string | null {
  return /^\s*([A-Za-z][A-Za-z0-9_]+-\d+)(?=$|[\s:.,)\]-])/.exec(text)?.[1]?.toUpperCase() ?? null;
}
