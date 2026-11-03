export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;

  const value = email.trim().toLowerCase();
  if (value.length === 0 || value.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;

  return value;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string") return null;
  if (password.length < 8 || password.length > 200) return null;
  return password;
}
