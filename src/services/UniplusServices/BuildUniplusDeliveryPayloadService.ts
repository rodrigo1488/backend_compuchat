import { randomUUID } from "crypto";
import Setting from "../../models/Setting";
import Product from "../../models/Product";
import ProductVariationOption from "../../models/ProductVariationOption";
import PrintDevice from "../../models/PrintDevice";
import FormResponse from "../../models/FormResponse";
import Form from "../../models/Form";
import FormField from "../../models/FormField";
import { calcMenuItemLineTotal } from "../../helpers/gourmetOrderTotals";
import AppError from "../../errors/AppError";
import { isAgentConnected } from "../../libs/printWebSocket";
import { logger } from "../../utils/logger";
import {
  extractFormPrintDevicePks,
  isUniplusFlagEnabled,
  resolveItemUniplusCodigo,
} from "./ValidateUniplusPreflightService";

const DEFAULT_PAYMENT_MAP: Record<string, string> = {
  pix: "valorpix",
  dinheiro: "valordinheiro",
  cartao: "valorcartao",
  outro: "valoroutros",
};

const PAYMENT_COLUMNS = [
  "valordinheiro",
  "valorcartao",
  "valorpix",
  "valorcarteiradigital",
  "valoroutros",
  "valorcheque",
] as const;

export interface UniplusPayloadItem {
  codigoproduto: string;
  nomeproduto: string;
  quantidade: number;
  precounitario: number;
  valortotal: number;
  unidademedida: string;
  observacao: string;
  orderidintegracao: string;
  /** UUID com hífens — UNIQUE contamesitem_uk1; vazio colide no Unichef */
  hash: string;
}

export interface UniplusDeliveryPayload {
  event: "uniplus.delivery";
  protocol: string;
  formResponseId: number;
  contamesa: Record<string, unknown>;
  itens: UniplusPayloadItem[];
  /** Avisos de resolução (ex.: match só por nome) — agent ignora se não consumir */
  metadata?: {
    warnings?: string[];
  };
}

interface BuildRequest {
  companyId: number;
  form: Form;
  response: FormResponse;
  menuItems: any[];
  contactName?: string | null;
  contactPhone?: string | null;
  fields?: FormField[];
  answers?: Array<{ fieldId: number; answer: string | string[] }>;
}

const roundMoney = (n: number): number => Math.round(n * 100) / 100;

/**
 * UniPlus (Java UUID.fromString) exige UUID com hífens (8-4-4-4-12).
 * CHAR(40) no Postgres: preenche com espaços à direita.
 * Não remover hífens — hash sem hífen vira null no ORM e NPE em existeOperacaoPendenteUnichef.
 */
const padHash = (uuid: string): string => {
  const trimmed = String(uuid || "").trim();
  const hex = trimmed.replace(/-/g, "").replace(/\s/g, "");
  let withHyphens = trimmed;
  if (/^[0-9a-fA-F]{32}$/.test(hex)) {
    withHyphens = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return withHyphens.padEnd(40, " ").slice(0, 40);
};

function answerToString(answer: string | string[] | null | undefined): string {
  if (answer == null) return "";
  if (Array.isArray(answer)) return answer.map(String).filter(Boolean).join(", ").trim();
  return String(answer).trim();
}

async function getSettingMap(companyId: number): Promise<Record<string, string>> {
  const rows = await Setting.findAll({
    where: {
      companyId,
      key: [
        "uniplusEnabled",
        "uniplusIdFilial",
        "uniplusIdUsuario",
        "uniplusCnpjFilial",
        "uniplusPaymentMap",
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

function parsePaymentMap(raw: string | undefined): Record<string, string> {
  if (!raw) return { ...DEFAULT_PAYMENT_MAP };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { ...DEFAULT_PAYMENT_MAP, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_PAYMENT_MAP };
}

function normalizePaymentMethod(raw: string): string {
  const v = String(raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (v.includes("pix")) return "pix";
  if (v.includes("dinheiro") || v.includes("especie")) return "dinheiro";
  if (v.includes("cartao") || v.includes("credito") || v.includes("debito")) return "cartao";
  if (v.includes("carteira")) return "carteira_digital";
  return "outro";
}

function findAnswerByLabel(
  fields: FormField[] | undefined,
  answers: Array<{ fieldId: number; answer: string | string[] }> | undefined,
  patterns: RegExp[]
): string {
  if (!fields?.length || !answers?.length) return "";
  for (const field of fields) {
    const label = String(field.label || "").toLowerCase();
    if (!patterns.some((p) => p.test(label))) continue;
    const ans = answers.find((a) => a.fieldId === field.id);
    const value = answerToString(ans?.answer);
    if (value) return value;
  }
  return "";
}

type ProductLite = { id: number; name?: string | null; idUniplus?: string | null };

export function formatHalfFlavorLabel(
  productId: number | null | undefined,
  productById: Map<number, ProductLite>
): string {
  const id = Number(productId);
  if (!Number.isFinite(id) || id <= 0) return "";
  const p = productById.get(id);
  if (!p) return "";
  const codigo = String(p.idUniplus || "").trim();
  const nome = String(p.name || "").trim();
  if (codigo && nome) return `${codigo} ${nome}`;
  return codigo || nome;
}

/** Exposta para testes do contrato meio a meio → CONTAMESAITEM.observacao */
export function buildObservacao(
  item: any,
  productById: Map<number, ProductLite> = new Map()
): string {
  const parts: string[] = [];
  if (item.type === "halfAndHalf") {
    const name = String(item.productName || "");
    const half1 = formatHalfFlavorLabel(item.half1ProductId, productById);
    const half2 = formatHalfFlavorLabel(item.half2ProductId, productById);
    if (half1 || half2) {
      parts.push(`Meio a meio: ${half1 || "?"} / ${half2 || "?"}`);
    }
    // Nome completo (pode truncar em nomeproduto 120) — reforça na observação
    if (/metade/i.test(name) || /meio\s*a\s*meio/i.test(name)) {
      parts.push(name.slice(0, 160));
    } else if (name && !half1 && !half2) {
      parts.push("Meio a meio");
      parts.push(name.slice(0, 160));
    }
  }
  if (Array.isArray(item.addons) && item.addons.length) {
    const addons = item.addons
      .map((a: any) => a.label || a.name)
      .filter(Boolean)
      .join(", ");
    if (addons) parts.push(`+ ${addons}`);
  }
  if (item.observacao || item.observation) {
    parts.push(String(item.observacao || item.observation));
  }
  return parts.join(" | ").slice(0, 255);
}

export async function isUniplusEnabledForCompany(companyId: number): Promise<boolean> {
  const settings = await getSettingMap(companyId);
  return isUniplusFlagEnabled(settings.uniplusEnabled);
}

export async function getUniplusPrintDeviceId(companyId: number): Promise<number | null> {
  const settings = await getSettingMap(companyId);
  const id = Number(settings.uniplusPrintDeviceId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Resolve deviceId (string do agente) sem preflight:
 * prioriza impressoras de delivery do cardápio, depois uniplusPrintDeviceId.
 * Prefere agent online; senão o primeiro encontrado.
 */
export async function resolveUniplusDeviceId(
  companyId: number,
  form: Form
): Promise<string | null> {
  const settings = await getSettingMap(companyId);
  const configuredPk = Number(settings.uniplusPrintDeviceId);
  const deliveryPks = extractFormPrintDevicePks(form);

  const candidates: number[] = [];
  for (const pk of deliveryPks) {
    if (Number.isFinite(pk) && pk > 0 && !candidates.includes(pk)) {
      candidates.push(pk);
    }
  }
  if (Number.isFinite(configuredPk) && configuredPk > 0 && !candidates.includes(configuredPk)) {
    candidates.push(configuredPk);
  }

  if (!candidates.length) return null;

  const foundDevices: PrintDevice[] = [];
  for (const pk of candidates) {
    const found = await PrintDevice.findOne({
      where: { id: pk, companyId },
    });
    if (found?.deviceId) foundDevices.push(found);
  }
  if (!foundDevices.length) return null;

  const printDevice =
    foundDevices.find((d) => isAgentConnected(companyId, d.deviceId)) ||
    foundDevices[0];

  if (deliveryPks.includes(printDevice.id) && Number(configuredPk) !== printDevice.id) {
    logger.info(
      `Uniplus: usando device de impressão do delivery companyId=${companyId} deviceId=${printDevice.deviceId} pk=${printDevice.id}`
    );
  }

  return printDevice.deviceId;
}

const BuildUniplusDeliveryPayloadService = async ({
  companyId,
  form,
  response,
  menuItems,
  contactName,
  contactPhone,
  fields,
  answers,
}: BuildRequest): Promise<UniplusDeliveryPayload> => {
  // Sem validação de flags company/form — despacho best-effort; agent resolve produtos
  const settings = await getSettingMap(companyId);
  void form;

  const protocol = String(response.protocol || `FR-${response.id}`).slice(0, 40);
  const meta = (response.metadata || {}) as Record<string, any>;
  const items = Array.isArray(menuItems) ? menuItems : [];

  // Inclui base + sabores do meio a meio (half1/half2) para observação com códigos UniPlus
  const productIds = [
    ...new Set(
      items
        .flatMap((it) => [
          Number(it.productId),
          Number(it.half1ProductId),
          Number(it.half2ProductId),
        ])
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
  const products = productIds.length
    ? await Product.findAll({
        where: { companyId, id: productIds },
        attributes: ["id", "name", "idUniplus", "value"],
      })
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));
  const catalog = await Product.findAll({
    where: { companyId },
    attributes: ["id", "name", "idUniplus"],
  });
  const catalogWithCode = catalog.filter((p) => String(p.idUniplus || "").trim());

  const optionIds = [
    ...new Set(
      items
        .flatMap((it) => [
          Number(it.variationOptionId),
          Number(it.baseOptionId),
          Number(it.half1OptionId),
          Number(it.half2OptionId),
        ])
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
  const options = optionIds.length
    ? await ProductVariationOption.findAll({
        where: { id: optionIds },
        attributes: ["id", "idUniplus", "label"],
      })
    : [];
  const optionById = new Map(options.map((o) => [o.id, o]));

  const payloadItems: UniplusPayloadItem[] = [];
  const warnings: string[] = [];
  for (const item of items) {
    const product = productById.get(Number(item.productId));
    const codigo = resolveItemUniplusCodigo(
      item,
      productById,
      catalogWithCode,
      optionById
    );
    const nomeproduto = String(
      item.productName || product?.name || "Produto"
    ).slice(0, 120);
    const qty = Number(item.quantity) || 1;
    const lineTotal = calcMenuItemLineTotal(item);
    const unit = roundMoney(lineTotal / qty);

    const optionCodigo = [
      Number(item.variationOptionId),
      Number(item.baseOptionId),
      Number(item.half1OptionId),
      Number(item.half2OptionId),
    ]
      .filter((id) => Number.isFinite(id) && id > 0)
      .some((id) => String(optionById.get(id)?.idUniplus || "").trim());
    const baseHasCodigo = Boolean(String(product?.idUniplus || "").trim());
    if (!codigo) {
      const msg = `item productId=${item.productId} sem idUniplus — agent resolverá por nome (risco de ambiguidade): ${nomeproduto}`;
      warnings.push(msg);
      logger.warn(
        {
          protocol,
          productId: item.productId,
          type: item.type,
          nomeproduto,
        },
        "Uniplus payload: item sem idUniplus — agent resolverá por nome (risco de ambiguidade)"
      );
    } else if (
      item.type === "halfAndHalf" &&
      !baseHasCodigo &&
      !optionCodigo
    ) {
      const msg = `meio a meio productId=${item.productId} com codigo=${codigo} resolvido por nome longo (base sem idUniplus): ${nomeproduto}`;
      warnings.push(msg);
      logger.warn(
        {
          protocol,
          productId: item.productId,
          codigo,
          nomeproduto,
        },
        "Uniplus payload: meio a meio com codigo resolvido por nome (base sem idUniplus)"
      );
    }

    payloadItems.push({
      // codigo pode vir vazio — agent resolve por nome no UniPlus
      codigoproduto: (codigo || "").slice(0, 20),
      nomeproduto,
      quantidade: qty,
      precounitario: unit,
      valortotal: lineTotal,
      unidademedida: "UN",
      observacao: buildObservacao(item, productById),
      orderidintegracao: protocol,
      hash: padHash(randomUUID()),
    });
  }

  if (!payloadItems.length) {
    throw new AppError("ERR_UNIPLUS_NO_ITEMS", 400);
  }

  const deliveryFee = roundMoney(Number(meta.deliveryFee) || 0);
  const subtotal = roundMoney(
    payloadItems.reduce((sum, it) => sum + Number(it.valortotal), 0)
  );
  const total = roundMoney(
    Number(meta.total) || subtotal + deliveryFee
  );

  const paymentLabel = findAnswerByLabel(fields, answers, [
    /pagamento/,
    /forma\s*de\s*pag/,
    /meio\s*de\s*pag/,
    /m[eé]todo\s*de\s*pag/,
  ]);
  const paymentMethod = normalizePaymentMethod(paymentLabel || "outro");
  const paymentMap = parsePaymentMap(settings.uniplusPaymentMap);
  let column = paymentMap[paymentMethod] || paymentMap.outro || "valoroutros";
  if (paymentMethod === "carteira_digital") {
    column = "valorcarteiradigital";
  }
  if (!(PAYMENT_COLUMNS as readonly string[]).includes(column)) {
    column = "valoroutros";
  }

  const valorPagamentos: Record<string, number> = {
    valordinheiro: 0,
    valorcartao: 0,
    valorpix: 0,
    valorcarteiradigital: 0,
    valoroutros: 0,
    valorcheque: 0,
  };
  valorPagamentos[column] = total;

  const endereco =
    findAnswerByLabel(fields, answers, [/^endereco$/, /endereço/, /rua/]) ||
    String(meta.endereco || "");
  const endereconumero =
    findAnswerByLabel(fields, answers, [/n[uú]mero/, /^numero$/]) ||
    String(meta.endereconumero || "");
  const enderecobairro =
    findAnswerByLabel(fields, answers, [/bairro/]) ||
    String(meta.enderecobairro || "");
  const enderecocomplemento =
    findAnswerByLabel(fields, answers, [/complemento/]) ||
    String(meta.enderecocomplemento || "");
  const enderecoreferencia =
    findAnswerByLabel(fields, answers, [/refer[eê]ncia/, /referencia/]) ||
    String(meta.enderecoreferencia || "");
  const documento =
    findAnswerByLabel(fields, answers, [/cpf/, /cnpj/, /documento/]) ||
    String(meta.documento || "");

  const now = new Date();
  const idFilial = Number(settings.uniplusIdFilial) || 1;
  const idUsuario = Number(settings.uniplusIdUsuario) || 1;
  const cnpjFilial = String(settings.uniplusCnpjFilial || "").trim().slice(0, 18);
  const hash = padHash(randomUUID());

  const contamesa: Record<string, unknown> = {
    tipopedido: 0,
    status: 1,
    situacao: 0,
    // UniPlus Delivery card = numeromesa. O agente aloca um número único por conta aberta.
    numeromesa: null,
    statusagendamento: 3,
    pautaunica: 1,
    // Alinhado à inserção nativa do UniPlus
    abertaoffline: 1,
    idfilial: idFilial,
    idusuario: idUsuario,
    cnpjfilial: cnpjFilial,
    idcliente: 0,
    codigocliente: "",
    // Unico usa `nome` na listagem de delivery; `nomecliente` fica como espelho.
    nome: String(contactName || response.responderName || "Cliente").slice(0, 60),
    nomecliente: String(contactName || response.responderName || "Cliente").slice(0, 60),
    telefone: String(contactPhone || response.responderPhone || "").slice(0, 20),
    documento: String(documento).slice(0, 18),
    endereco: String(endereco).slice(0, 60),
    endereconumero: String(endereconumero).slice(0, 12),
    enderecobairro: String(enderecobairro).slice(0, 255),
    enderecocomplemento: String(enderecocomplemento).slice(0, 255),
    enderecoreferencia: String(enderecoreferencia).slice(0, 255),
    valorentrega: deliveryFee,
    valortotal: total,
    valorcombinado: total,
    ...valorPagamentos,
    tipointegracao: 0,
    nomeintegracao: "",
    orderidintegracao: protocol,
    hash,
    statussinc: 1,
    cupomcancelado: 0,
    retiradanobalcao: 0,
    retirabalcaodepois: 0,
    paraviagem: 0,
    numeropessoas: 1,
    desconto: 0,
    obs: `Compuchat ${protocol}`.slice(0, 255),
    data: now.toISOString().slice(0, 10),
    horaabertura: now.toISOString(),
    horaultimoconsumo: now.toISOString(),
    horapedidoefetuado: now.toISOString(),
    currenttimemillis: Date.now(),
    timestampalteracao: Date.now(),
  };

  return {
    event: "uniplus.delivery",
    protocol,
    formResponseId: response.id,
    contamesa,
    itens: payloadItems,
    ...(warnings.length ? { metadata: { warnings } } : {}),
  };
};

export default BuildUniplusDeliveryPayloadService;
