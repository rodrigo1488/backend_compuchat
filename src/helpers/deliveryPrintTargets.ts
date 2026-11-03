export interface DeliveryGroupPrintRow {
  printDeviceId: number;
  groupNames: string[];
}

const itemGroupName = (item: { grupo?: unknown }): string => {
  const name = String(item?.grupo ?? "Outros").trim();
  return name || "Outros";
};

/** Junta linhas da mesma impressora e descarta dispositivo ou grupo vazio. */
export const normalizeDeliveryGroupPrintConfig = (
  raw: unknown
): DeliveryGroupPrintRow[] => {
  if (!Array.isArray(raw)) return [];
  const byDevice = new Map<number, Set<string>>();
  for (const row of raw) {
    const id = Number(row?.printDeviceId);
    if (!Number.isFinite(id) || id <= 0) continue;
    const groups = Array.isArray(row?.groupNames) ? row.groupNames : [];
    if (!byDevice.has(id)) byDevice.set(id, new Set());
    for (const group of groups) {
      const name = String(group ?? "").trim();
      if (name) byDevice.get(id)!.add(name);
    }
  }
  return [...byDevice.entries()]
    .filter(([, groups]) => groups.size > 0)
    .map(([printDeviceId, groups]) => ({
      printDeviceId,
      groupNames: [...groups],
    }));
};

export const deliveryOrderMatchesGroups = (
  menuItems: Array<{ grupo?: unknown }>,
  groupNames: string[]
): boolean => {
  if (!menuItems?.length || !groupNames?.length) return false;
  if (groupNames.some((group) => group.trim() === "*")) return true;
  const wanted = new Set(
    groupNames.map((group) => group.trim().toLowerCase()).filter(Boolean)
  );
  return menuItems.some((item) => wanted.has(itemGroupName(item).toLowerCase()));
};

/**
 * Impressoras do delivery: as marcadas sempre, mais as de grupo quando o pedido
 * tiver item daquele grupo. A mesma impressora não entra duas vezes.
 */
export const resolveDeliveryPrintDeviceIds = (
  settings: {
    printDeviceId?: unknown;
    deliveryPrintDeviceIds?: unknown;
    deliveryGroupPrintConfig?: unknown;
  } | null | undefined,
  menuItems: Array<{ grupo?: unknown }>
): number[] => {
  const configured = Array.isArray(settings?.deliveryPrintDeviceIds)
    ? (settings!.deliveryPrintDeviceIds as unknown[])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    : [];
  const legacyId = Number(settings?.printDeviceId) || 0;
  const base = configured.length ? configured : legacyId > 0 ? [legacyId] : [];

  const seen = new Set<number>();
  const ids: number[] = [];
  const push = (id: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  base.forEach(push);
  for (const row of normalizeDeliveryGroupPrintConfig(settings?.deliveryGroupPrintConfig)) {
    if (seen.has(row.printDeviceId)) continue;
    if (!deliveryOrderMatchesGroups(menuItems, row.groupNames)) continue;
    push(row.printDeviceId);
  }
  return ids;
};
