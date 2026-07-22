import { randomUUID } from "crypto";
import Setting from "../../models/Setting";
import Product from "../../models/Product";
import FormResponse from "../../models/FormResponse";
import Form from "../../models/Form";
import FormField from "../../models/FormField";
import { calcMenuItemLineTotal } from "../../helpers/gourmetOrderTotals";
import AppError from "../../errors/AppError";

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
}

export interface UniplusDeliveryPayload {
  event: "uniplus.delivery";
  protocol: string;
  formResponseId: number;
  contamesa: Record<string, unknown>;
  itens: UniplusPayloadItem[];
}

interface BuildRequest {
  companyId: number;
  form: Form;
  response: FormResponse;
  menuItems: any[];
  contactName?: string | null;
  contactPhone?: string | null;
  fields?: FormField[];
  answers?: Array<{ fieldId: number; answer: string }>;
}

const roundMoney = (n: number): number => Math.round(n * 100) / 100;

const padHash = (uuid: string): string => uuid.replace(/-/g, "").padEnd(40, " ").slice(0, 40);

async function getSettingMap(companyId: number): Promise<Record<string, string>> {
  const rows = await Setting.findAll({
    where: {
      companyId,
      key: [
        "uniplusEnabled",
        "uniplusIdFilial",
        "uniplusIdUsuario",
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
  answers: Array<{ fieldId: number; answer: string }> | undefined,
  patterns: RegExp[]
): string {
  if (!fields?.length || !answers?.length) return "";
  for (const field of fields) {
    const label = String(field.label || "").toLowerCase();
    if (!patterns.some((p) => p.test(label))) continue;
    const ans = answers.find((a) => a.fieldId === field.id);
    if (ans?.answer != null && String(ans.answer).trim() !== "") {
      return String(ans.answer).trim();
    }
  }
  return "";
}

function buildObservacao(item: any): string {
  const parts: string[] = [];
  if (item.type === "halfAndHalf") {
    parts.push("Meio a meio");
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
  return settings.uniplusEnabled === "enabled";
}

export async function getUniplusPrintDeviceId(companyId: number): Promise<number | null> {
  const settings = await getSettingMap(companyId);
  const id = Number(settings.uniplusPrintDeviceId);
  return Number.isFinite(id) && id > 0 ? id : null;
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
  const settings = await getSettingMap(companyId);
  if (settings.uniplusEnabled !== "enabled") {
    throw new AppError("ERR_UNIPLUS_DISABLED", 400);
  }

  const formSettings = (form.settings || {}) as Record<string, any>;
  if (formSettings?.uniplus?.enabled !== true) {
    throw new AppError("ERR_UNIPLUS_FORM_DISABLED", 400);
  }

  const protocol = String(response.protocol || `FR-${response.id}`).slice(0, 40);
  const meta = (response.metadata || {}) as Record<string, any>;
  const items = Array.isArray(menuItems) ? menuItems : [];

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
        attributes: ["id", "name", "idUniplus", "value"],
      })
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));

  const payloadItems: UniplusPayloadItem[] = [];
  for (const item of items) {
    const product = productById.get(Number(item.productId));
    const codigo = String(product?.idUniplus || item.idUniplus || "").trim();
    if (!codigo) {
      throw new AppError(
        `ERR_UNIPLUS_PRODUCT_CODE_MISSING:${item.productName || item.productId}`,
        400
      );
    }
    const qty = Number(item.quantity) || 1;
    const lineTotal = calcMenuItemLineTotal(item);
    const unit = roundMoney(lineTotal / qty);
    payloadItems.push({
      codigoproduto: codigo.slice(0, 20),
      nomeproduto: String(item.productName || product?.name || "Produto").slice(0, 120),
      quantidade: qty,
      precounitario: unit,
      valortotal: lineTotal,
      unidademedida: "UN",
      observacao: buildObservacao(item),
      orderidintegracao: protocol,
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
  const hash = padHash(randomUUID());

  const contamesa: Record<string, unknown> = {
    tipopedido: 0,
    status: 1,
    situacao: 0,
    numeromesa: 1,
    idfilial: idFilial,
    idusuario: idUsuario,
    idcliente: 0,
    codigocliente: "",
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
    currenttimemillis: Date.now(),
    timestampalteracao: Date.now(),
  };

  return {
    event: "uniplus.delivery",
    protocol,
    formResponseId: response.id,
    contamesa,
    itens: payloadItems,
  };
};

export default BuildUniplusDeliveryPayloadService;
