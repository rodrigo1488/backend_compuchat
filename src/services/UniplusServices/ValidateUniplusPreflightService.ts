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
 * Valida pré-requisitos UniPlus sem lançar erro ao cliente.
 * Pedido Compuchat nunca deve ser bloqueado por este serviço.
 */
const ValidateUniplusPreflightService = async ({
  companyId,
  form,
  menuItems,
  orderType,
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
  // (igual ao comportamento anterior às validações estritas).
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

  const devicePk = Number(settings.uniplusPrintDeviceId);
  if (!Number.isFinite(devicePk) || devicePk <= 0) {
    return {
      ok: false,
      code: "ERR_UNIPLUS_DEVICE_NOT_SET",
      message: "uniplusPrintDeviceId não configurado",
    };
  }

  const printDevice = await PrintDevice.findOne({
    where: { id: devicePk, companyId },
  });
  if (!printDevice?.deviceId) {
    return {
      ok: false,
      code: "ERR_UNIPLUS_DEVICE_NOT_FOUND",
      message: `PrintDevice UniPlus não encontrado id=${devicePk}`,
    };
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
    message: "preflight ok",
    deviceId: printDevice.deviceId,
  };
};

export default ValidateUniplusPreflightService;
