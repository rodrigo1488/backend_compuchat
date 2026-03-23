import AppError from "../errors/AppError";

const DEFAULT_TZ = "America/Sao_Paulo";

function parseTimeToMinutes(s: unknown): number | null {
  if (s == null || s === "") return null;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function getMinutesInTimeZone(now: Date, timeZone: string): number {
  const tz = timeZone || DEFAULT_TZ;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    return hour * 60 + minute;
  } catch {
    return getMinutesInTimeZone(now, DEFAULT_TZ);
  }
}

export function isWithinMenuOrderHours(
  settings: Record<string, unknown> | undefined,
  now: Date = new Date()
): boolean {
  if (!settings || !settings.orderHoursEnabled) return true;
  const startS = settings.orderHoursStart as string | undefined;
  const endS = settings.orderHoursEnd as string | undefined;
  if (!startS || !endS) return true;
  const startM = parseTimeToMinutes(startS);
  const endM = parseTimeToMinutes(endS);
  if (startM == null || endM == null) return true;
  if (startM === endM) return true;
  const tz = (settings.orderHoursTimezone as string) || DEFAULT_TZ;
  const cur = getMinutesInTimeZone(now, tz);
  if (startM < endM) {
    return cur >= startM && cur <= endM;
  }
  return cur >= startM || cur <= endM;
}

function getMenuOrderHoursClosedMessage(settings: Record<string, unknown> | undefined): string {
  const custom = String(settings?.orderHoursMessage ?? "").trim();
  if (custom) return custom;
  const start = String(settings?.orderHoursStart ?? "") || "—";
  const end = String(settings?.orderHoursEnd ?? "") || "—";
  const tz = (settings?.orderHoursTimezone as string) || DEFAULT_TZ;
  const tzLabel =
    tz === "America/Sao_Paulo"
      ? "Brasília"
      : ["America/Fortaleza", "America/Recife", "America/Maceio"].includes(tz)
        ? "Brasil (Nordeste)"
        : tz === "America/Manaus"
          ? "Manaus"
          : tz;
  return (
    "Prezado cliente, informamos que, no momento, não estamos recebendo pedidos pelo cardápio digital. " +
    `Nosso horário de atendimento para pedidos é das ${start} às ${end} ` +
    `(horário de ${tzLabel}). Agradecemos a compreensão.`
  );
}

/** Lança AppError 400 se pedidos estiverem fora do horário configurado. */
export function assertMenuOrderHoursAllowed(settings: Record<string, unknown> | undefined): void {
  if (!settings?.orderHoursEnabled) return;
  if (isWithinMenuOrderHours(settings)) return;
  throw new AppError(getMenuOrderHoursClosedMessage(settings), 400);
}
