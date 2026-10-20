import Form from "../../models/Form";
import FormField from "../../models/FormField";
import FormResponse from "../../models/FormResponse";
import ResponseAnswer from "../../models/ResponseAnswer";
import AppError from "../../errors/AppError";
import { normalizeMenuItems } from "../FormServices/ProcessFormResponseService";
import { findOrderTypeField, inferFulfillmentMode } from "../../helpers/fulfillmentMode";
import ResolveDeliveryFee from "../FormServices/ResolveDeliveryFee";
import DispatchFreshDeliveryPrintService from "./DispatchFreshDeliveryPrintService";

const BLOCKED_STATUSES = new Set(["entregue", "cancelado"]);

export type DeliveryOrderAddressInput = {
  endereco?: string;
  endereconumero?: string;
  enderecobairro?: string;
  enderecocomplemento?: string;
  enderecoreferencia?: string;
};

export type FulfillmentModeInput = "delivery" | "pickup";

export type UpdateDeliveryOrderInput = {
  companyId: number;
  formId: number;
  responseId: number;
  responderName?: string;
  menuItems?: Record<string, unknown>[];
  address?: DeliveryOrderAddressInput;
  fulfillmentMode?: FulfillmentModeInput;
};

const applyAddressToAnswers = async (
  fields: FormField[],
  responseId: number,
  address: DeliveryOrderAddressInput
): Promise<void> => {
  const mapping: Array<[keyof DeliveryOrderAddressInput, string]> = [
    ["endereco", "address"],
    ["endereconumero", "number"],
    ["enderecobairro", "neighborhood"],
    ["enderecocomplemento", "complement"],
    ["enderecoreferencia", "reference"],
  ];

  for (const [metaKey, autoType] of mapping) {
    const value = address[metaKey];
    if (value === undefined) continue;
    const field = fields.find(
      (f) => String((f.metadata as any)?.autoFieldType || "") === autoType
    );
    if (!field?.id) continue;
    const existing = await ResponseAnswer.findOne({
      where: { responseId, fieldId: field.id },
    });
    const text = String(value ?? "").trim();
    if (existing) {
      await existing.update({ answer: text, answerData: { value: text } });
    } else if (text) {
      await ResponseAnswer.create({
        responseId,
        fieldId: field.id,
        answer: text,
        answerData: { value: text },
      });
    }
  }
};

const labelForMode = (field: FormField, mode: FulfillmentModeInput): string => {
  const options = Array.isArray(field.options) ? field.options.map((opt) => String(opt)) : [];
  for (const opt of options) {
    const inferred = inferFulfillmentMode(
      "delivery",
      [{ id: field.id, label: field.label || "tipo de pedido" }],
      [{ fieldId: field.id, answer: opt }]
    );
    if (inferred === mode) return opt;
  }
  return mode === "pickup" ? "Retirada no balcão" : "Entrega";
};

const applyFulfillmentAnswer = async (
  fields: FormField[],
  responseId: number,
  mode: FulfillmentModeInput
): Promise<void> => {
  const field = findOrderTypeField(fields) as FormField | undefined;
  if (!field?.id) return;
  const text = labelForMode(field, mode);
  const existing = await ResponseAnswer.findOne({
    where: { responseId, fieldId: field.id },
  });
  if (existing) {
    await existing.update({ answer: text, answerData: { value: text } });
  } else {
    await ResponseAnswer.create({
      responseId,
      fieldId: field.id,
      answer: text,
      answerData: { value: text },
    });
  }
};

const UpdateDeliveryOrderService = async ({
  companyId,
  formId,
  responseId,
  responderName,
  menuItems,
  address,
  fulfillmentMode,
}: UpdateDeliveryOrderInput): Promise<{
  response: FormResponse;
  print: { dispatched: number; jobs: Array<{ deviceId: string; jobId: number; dispatched: boolean }> };
}> => {
  const form = await Form.findOne({
    where: { id: formId, companyId },
    include: [{ association: "fields", separate: true, order: [["order", "ASC"]] }],
  });
  if (!form) {
    throw new AppError("ERR_FORM_NOT_FOUND", 404);
  }

  const response = await FormResponse.findOne({
    where: { id: responseId, formId },
    include: [{ association: "answers", include: [{ association: "field" }] }],
  });
  if (!response) {
    throw new AppError("ERR_RESPONSE_NOT_FOUND", 404);
  }

  const meta = { ...(response.metadata as Record<string, unknown>) };
  if (meta.orderType !== "delivery") {
    throw new AppError("Só é possível editar pedidos delivery.", 400);
  }

  const status = String(response.orderStatus || meta.orderStatus || "novo");
  if (BLOCKED_STATUSES.has(status)) {
    throw new AppError("Pedido entregue ou cancelado não pode ser editado.", 409);
  }

  const fields = (form.fields || []) as FormField[];
  let normalizedItems = (meta.menuItems || []) as Record<string, unknown>[];

  if (Array.isArray(menuItems)) {
    if (!menuItems.length) {
      throw new AppError("O pedido precisa ter ao menos um item.", 400);
    }
    normalizedItems = await normalizeMenuItems(menuItems as any, companyId);
  }

  let subtotal = 0;
  for (const it of normalizedItems) {
    const qty = Number((it as any).quantity) || 0;
    const unit =
      (Number((it as any).productValue) || 0) +
      (Number((it as any).addonsTotal) || 0);
    subtotal += qty * unit;
  }
  subtotal = Math.round(subtotal * 100) / 100;

  const previousMode: FulfillmentModeInput =
    meta.fulfillmentMode === "pickup" || meta.pickup === true || meta.retirada === true
      ? "pickup"
      : "delivery";
  const nextMode: FulfillmentModeInput =
    fulfillmentMode === "pickup" || fulfillmentMode === "delivery"
      ? fulfillmentMode
      : previousMode;

  const settings = (form.settings || {}) as Record<string, unknown>;
  const configuredFee = Number(settings.deliveryFee) || 0;
  let deliveryFee = Number(meta.deliveryFee) || 0;
  if (nextMode === "pickup") {
    deliveryFee = 0;
  } else if (previousMode === "pickup") {
    const resolved = ResolveDeliveryFee(
      form as any,
      (response.answers || []).map((a) => ({ fieldId: a.fieldId, answer: a.answer })),
      { orderType: "delivery" }
    );
    deliveryFee = resolved.deliveryFee > 0 ? resolved.deliveryFee : configuredFee;
  }
  deliveryFee = Math.round(deliveryFee * 100) / 100;

  const couponDiscount = Number(meta.couponDiscount) || 0;
  const total =
    Math.round((subtotal + deliveryFee - couponDiscount) * 100) / 100;

  const minOrderValue = Number(settings.minOrderValue) || 0;
  if (nextMode === "delivery" && minOrderValue > 0 && subtotal < minOrderValue) {
    throw new AppError(
      `Pedido mínimo de R$ ${minOrderValue.toFixed(2).replace(".", ",")} para delivery.`,
      400
    );
  }

  const nextMeta: Record<string, unknown> = {
    ...meta,
    menuItems: normalizedItems,
    subtotal,
    deliveryFee,
    total,
    fulfillmentMode: nextMode,
    pickup: nextMode === "pickup",
    retirada: nextMode === "pickup",
  };

  if (responderName != null) {
    const name = String(responderName).trim() || "Cliente";
    nextMeta.customerName = name;
    await response.update({ responderName: name });
  }

  if (nextMode === "delivery" && address) {
    if (address.endereco !== undefined) nextMeta.endereco = String(address.endereco || "").trim();
    if (address.endereconumero !== undefined) {
      nextMeta.endereconumero = String(address.endereconumero || "").trim();
    }
    if (address.enderecobairro !== undefined) {
      nextMeta.enderecobairro = String(address.enderecobairro || "").trim();
    }
    if (address.enderecocomplemento !== undefined) {
      nextMeta.enderecocomplemento = String(address.enderecocomplemento || "").trim();
    }
    if (address.enderecoreferencia !== undefined) {
      nextMeta.enderecoreferencia = String(address.enderecoreferencia || "").trim();
    }
    await applyAddressToAnswers(fields, response.id, address);
  }

  await applyFulfillmentAnswer(fields, response.id, nextMode);

  if (nextMode === "delivery" && !String(nextMeta.endereco || "").trim()) {
    throw new AppError("ERR_DELIVERY_ADDRESS_REQUIRED", 400);
  }

  await response.update({ metadata: nextMeta });
  await response.reload({
    include: [{ association: "answers", include: [{ association: "field" }] }],
  });

  const print = await DispatchFreshDeliveryPrintService({
    companyId,
    formId,
    formResponseId: response.id,
  });

  return { response, print };
};

export default UpdateDeliveryOrderService;
