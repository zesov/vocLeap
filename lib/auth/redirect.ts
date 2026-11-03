export const DEFAULT_AUTH_REDIRECT = "/review";

export function safeNext(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;

  if (
    !candidate ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    /\s/.test(candidate)
  ) {
    return DEFAULT_AUTH_REDIRECT;
  }

  return candidate;
}
