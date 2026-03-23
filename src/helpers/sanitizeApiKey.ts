/**
 * Remove caracteres invisíveis comuns ao colar chaves (BOM, zero-width, quebras de linha).
 */
export function sanitizeApiKey(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value)
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r?\n/g, "")
    .trim();
}

/** Remove prefixo "Bearer " se o usuário colou por engano. */
export function stripBearerPrefix(value: string): string {
  const s = value.trim();
  if (/^bearer\s+/i.test(s)) {
    return s.replace(/^bearer\s+/i, "").trim();
  }
  return s;
}
