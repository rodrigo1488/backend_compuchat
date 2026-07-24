import Setting from "../../models/Setting";
import Product from "../../models/Product";
import PrintDevice from "../../models/PrintDevice";
import Form from "../../models/Form";
import { logger } from "../../utils/logger";

export type UniplusPreflightCode =
  | "OK"
  | "ERR_UNIPLUS_COMPANY_DISABLED"
  | "ERR_UNIPLUS_FORM_DISABLED"
  | "ERR_UNIPLUS_NOT_DELIVERY"
  | "ERR_UNIPLUS_NO_ITEMS"
  | "ERR_UNIPLUS_DEVICE_NOT_SET"
  | "ERR_UNIPLUS_DEVICE_NOT_FOUND"
  | "ERR_UNIPLUS_ID_FILIAL_INVALID"
  | "ERR_UNIPLUS_ID_USUARIO_INVALID"
  | "ERR_UNIPLUS_PRODUCT_CODE_MISSING";

export interface UniplusPreflightResult {
  ok: boolean;
  code: UniplusPreflightCode;
  message: string;
  deviceId?: string;
  missingProductIds?: number[];
  missingProductNames?: string[];
}

interface PreflightRequest {
  companyId: number;
  form: Form;
  menuItems: any[];
  orderType?: string | null;
  /** PKs de PrintDevice do cardápio (delivery/print) usados se uniplusPrintDeviceId não estiver setado */
  fallbackDevicePks?: number[];
}

async function getSettingMap(companyId: number): Promise<Record<string, string>> {
  const rows = await Setting.findAll({
    where: {
      companyId,
      key: [
        "uniplusEnabled",
        "uniplusIdFilial",
        "uniplusIdUsuario",
        "uniplusPrintDeviceId",
      ],
    },
  });
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.key] = row.value ?? "";
  }
  return map;
}

/**
 * Extrai PrintDevice PKs configurados no cardápio para impressão delivery/mesa.
 */
export function extractFormPrintDevicePks(form: Form): number[] {
  const settings = (form.settings || {}) as Record<string, any>;
  const ids = new Set<number>();

  const deliveryIds = settings.deliveryPrintDeviceIds;
  if (Array.isArray(deliveryIds)) {
    for (const id of deliveryIds) {
      const n = Number(id);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    }
  }

  const printDeviceId = Number(settings.printDeviceId);
  if (Number.isFinite(printDeviceId) && printDeviceId > 0) {
    ids.add(printDeviceId);
  }

  const mesaPrintConfig = settings.mesaPrintConfig;
  if (Array.isArray(mesaPrintConfig)) {
    for (const row of mesaPrintConfig) {
      const n = Number(row?.printDeviceId);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    }
  }

  return [...ids];
}

/**
 * Valida pré-requisitos UniPlus sem lançar erro ao cliente.
 * Pedido Compuchat nunca deve ser bloqueado por este serviço.
 */
const ValidateUniplusPreflightService = async ({
  companyId,
  form,
  menuItems,
  orderType,
  fallbackDevicePks,
}: PreflightRequest): Promise<UniplusPreflightResult> => {
  const formUniplus = (form.settings as any)?.uniplus;
  if (formUniplus?.enabled !== true) {
    return {
      ok: false,
      code: "ERR_UNIPLUS_FORM_DISABLED",
      message: "UniPlus desabilitado neste cardápio",
    };
  }

  if (String(orderType || "").toLowerCase() !== "delivery") {
    return {
      ok: false,
      code: "ERR_UNIPLUS_NOT_DELIVERY",
      message: "UniPlus só sincroniza pedidos delivery",
    };
  }

  const items = Array.isArray(menuItems) ? menuItems : [];
  if (!items.length) {
    return {
      ok: false,
      code: "ERR_UNIPLUS_NO_ITEMS",
      message: "Pedido sem itens para UniPlus",
    };
  }

  const settings = await getSettingMap(companyId);
  if (settings.uniplusEnabled !== "enabled") {
    return {
      ok: false,
      code: "ERR_UNIPLUS_COMPANY_DISABLED",
      message: "UniPlus desabilitado nas configurações da empresa",
    };
  }

  // Filial/usuário: não bloquear despacho — o builder usa fallback || 1
  const idFilial = Number(settings.uniplusIdFilial);
  if (!Number.isFinite(idFilial) || idFilial <= 0) {
    logger.warn(
      `Uniplus preflight: uniplusIdFilial ausente/inválido companyId=${companyId} — seguirá com fallback 1`
    );
  }
  const idUsuario = Number(settings.uniplusIdUsuario);
  if (!Number.isFinite(idUsuario) || idUsuario <= 0) {
    logger.warn(
      `Uniplus preflight: uniplusIdUsuario ausente/inválido companyId=${companyId} — seguirá com fallback 1`
    );
  }

  const configuredPk = Number(settings.uniplusPrintDeviceId);
  const candidates: number[] = [];
  if (Number.isFinite(configuredPk) && configuredPk > 0) {
    candidates.push(configuredPk);
  }
  const fallbacks =
    Array.isArray(fallbackDevicePks) && fallbackDevicePks.length
      ? fallbackDevicePks
      : extractFormPrintDevicePks(form);
  for (const pk of fallbacks) {
    if (Number.isFinite(pk) && pk > 0 && !candidates.includes(pk)) {
      candidates.push(pk);
    }
  }

  if (!candidates.length) {
    return {
      ok: false,
      code: "ERR_UNIPLUS_DEVICE_NOT_SET",
      message:
        "uniplusPrintDeviceId não configurado e cardápio sem impressora de delivery",
    };
  }

  let printDevice: PrintDevice | null = null;
  let usedFallback = false;
  for (let i = 0; i < candidates.length; i++) {
    const pk = candidates[i];
    const found = await PrintDevice.findOne({
      where: { id: pk, companyId },
    });
    if (found?.deviceId) {
      printDevice = found;
      usedFallback = i > 0 || !(Number.isFinite(configuredPk) && configuredPk > 0);
      break;
    }
  }

  if (!printDevice?.deviceId) {
    return {
      ok: false,
      code: "ERR_UNIPLUS_DEVICE_NOT_FOUND",
      message: `Nenhum PrintDevice UniPlus válido entre candidatos=[${candidates.join(",")}]`,
    };
  }

  if (usedFallback) {
    logger.warn(
      `Uniplus preflight: usando device de impressão do cardápio como fallback companyId=${companyId} deviceId=${printDevice.deviceId} pk=${printDevice.id}`
    );
  }

  const productIds = [
    ...new Set(
      items
        .map((it) => Number(it.productId))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];

  const products = productIds.length
    ? await Product.findAll({
        where: { companyId, id: productIds },
        attributes: ["id", "name", "idUniplus"],
      })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  const missingIds: number[] = [];
  const missingNames: string[] = [];
  for (const item of items) {
    const pid = Number(item.productId);
    const product = byId.get(pid);
    const codigo = String(product?.idUniplus || item.idUniplus || "").trim();
    if (!codigo) {
      if (Number.isFinite(pid) && pid > 0) missingIds.push(pid);
      missingNames.push(String(item.productName || product?.name || pid || "?"));
    }
  }

  if (missingIds.length || missingNames.length) {
    const uniqueNames = [...new Set(missingNames)];
    logger.warn(
      `Uniplus preflight: produtos sem idUniplus companyId=${companyId}: ${uniqueNames.join(", ")}`
    );
    return {
      ok: false,
      code: "ERR_UNIPLUS_PRODUCT_CODE_MISSING",
      message: `Produtos sem código UniPlus: ${uniqueNames.join(", ")}`,
      missingProductIds: [...new Set(missingIds)],
      missingProductNames: uniqueNames,
    };
  }

  return {
    ok: true,
    code: "OK",
    message: usedFallback
      ? "preflight ok (device fallback do cardápio)"
      : "preflight ok",
    deviceId: printDevice.deviceId,
  };
};

export default ValidateUniplusPreflightService;
