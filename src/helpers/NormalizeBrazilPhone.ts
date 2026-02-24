/**
 * Normaliza números brasileiros para envio via WhatsApp (E.164 sem '+').
 *
 * Regras:
 * - Remove não-dígitos
 * - Garante prefixo "55" quando houver DDD+número
 * - Se vier com 8 dígitos após o DDD, **não inventa dígitos** quando já começa com 9
 * - Opcionalmente insere "9" apenas em casos prováveis de celular antigo (8 dígitos iniciando com 6/7/8)
 * - Tenta corrigir duplicação de "9" (caso raro)
 */
export function normalizeBrazilPhoneForWhatsapp(raw: string): string {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";

  // Se já tem 55
  if (digits.startsWith("55")) {
    // 55 + DDD(2) + 8 = 12 -> pode ser fixo (2-5) ou celular antigo (6-8). Se já começa com 9, não inserir.
    if (digits.length === 12) {
      const local8 = digits.slice(4); // 8 dígitos após DDD
      const first = local8[0];
      if (first === "9") return digits;
      if (first === "6" || first === "7" || first === "8") {
        return digits.slice(0, 4) + "9" + digits.slice(4);
      }
      return digits;
    }
    // Possível 9 duplicado (caso raro): 55 + DDD + 10 dígitos = 14
    // Ex.: 55DD99XXXXXXXX (um 9 extra inserido)
    if (digits.length === 14 && digits[4] === "9" && digits[5] === "9") {
      return digits.slice(0, 4) + digits.slice(5);
    }
    return digits;
  }

  // Sem 55: pode vir como DDD+telefone
  if (digits.length === 10) {
    const local8 = digits.slice(2);
    const first = local8[0];
    if (first === "9") return "55" + digits;
    if (first === "6" || first === "7" || first === "8") {
      return "55" + digits.slice(0, 2) + "9" + digits.slice(2);
    }
    return "55" + digits;
  }
  if (digits.length === 11) {
    // DDD(2) + 9
    return "55" + digits;
  }

  // Outros tamanhos: retorna como está (melhor que quebrar), mas sem caracteres.
  return digits;
}

