export function normalizedSecret(value: string | undefined | null) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : "";
}

