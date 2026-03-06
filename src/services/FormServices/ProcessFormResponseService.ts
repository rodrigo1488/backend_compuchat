import { Op } from "sequelize";
import Form from "../../models/Form";
import FormField from "../../models/FormField";
import FormResponse from "../../models/FormResponse";
import ResponseAnswer from "../../models/ResponseAnswer";
import CreateOrUpdateContactService from "../ContactServices/CreateOrUpdateContactService";
import CreateTicketService from "../TicketServices/CreateTicketService";
import FindOrCreateTicketService from "../TicketServices/FindOrCreateTicketService";
import GetDefaultWhatsApp from "../../helpers/GetDefaultWhatsApp";
import FormatMenuOrderMessage from "./FormatMenuOrderMessage";
import SendWhatsAppMessage from "../WbotServices/SendWhatsAppMessage";
import AppError from "../../errors/AppError";
import PrintDevice from "../../models/PrintDevice";
import CreateAndDispatchPrintJobService from "../PrintJobService/CreateAndDispatchPrintJobService";
import OcuparMesaService from "../MesaServices/OcuparMesaService";
import Mesa from "../../models/Mesa";
import Contact from "../../models/Contact";
import ContactCustomField from "../../models/ContactCustomField";
import Ticket from "../../models/Ticket";
import { verifyOrderToken, createDeliveryScanToken } from "../../helpers/MesaLinkSign";
import Product from "../../models/Product";
import Appointment from "../../models/Appointment";
import AppointmentService from "../../models/AppointmentService";
import FormatAppointmentConfirmationMessage from "./FormatAppointmentConfirmationMessage";
import { createAppointmentToken } from "../../helpers/MesaLinkSign";
import ProductVariation from "../../models/ProductVariation";
import ProductVariationOption from "../../models/ProductVariationOption";
import AddOnItem from "../../models/AddOnItem";
import GrupoAddOn from "../../models/GrupoAddOn";
import { normalizeBrazilPhoneForWhatsapp } from "../../helpers/NormalizeBrazilPhone";

interface Answer {
  fieldId: number;
  answer: string | string[];
  answerData?: object;
  fileUrl?: string;
}

interface OrderTriggerMessageRule {
  fieldId: number;
  optionValue: string;
  message: string;
}

interface Request {
  formId: number;
  answers: Answer[];
  quotationItems?: object[];
  menuItems?: Array<{
    productId: number;
    quantity: number;
    productName?: string;
    productValue?: number;
    grupo?: string;
    addons?: Array<{ addOnItemId: number; label?: string; value?: number }>;
  }>;
  responderPhone?: string;
  responderEmail?: string;
  responderName?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: object;
  /** Token de sessão da mesa (retornado ao abrir link assinado). Garante que o pedido vá para a mesa correta. */
  orderToken?: string;
}

type MenuItemInput = {
  productId?: number;
  quantity: number;
  productName?: string;
  productValue?: number;
  grupo?: string;
  type?: string;
  half1ProductId?: number;
  half2ProductId?: number;
  half1OptionId?: number | null;
  half2OptionId?: number | null;
  addons?: Array<{ addOnItemId: number; label?: string; value?: number }>;
};

/** Normaliza menuItems: para itens tipo halfAndHalf, calcula productValue e productName no backend. */
const normalizeMenuItems = async (
  items: MenuItemInput[],
  companyId: number
): Promise<any[]> => {
  const result: any[] = [];
  for (const item of items) {
    if ((item as any).type === "halfAndHalf" && item.productId && item.half1ProductId && item.half2ProductId) {
      const [base, half1, half2] = await Promise.all([
        Product.findOne({ 
          where: { id: item.productId, companyId }, 
          attributes: ["id", "name", "value", "halfAndHalfPriceRule"],
          include: [{
            model: ProductVariation,
            as: "variations",
            include: [{
              model: ProductVariationOption,
              as: "options"
            }]
          }]
        }),
        Product.findOne({ 
          where: { id: item.half1ProductId, companyId }, 
          attributes: ["id", "name", "value"],
          include: [{
            model: ProductVariation,
            as: "variations",
            include: [{
              model: ProductVariationOption,
              as: "options"
            }]
          }]
        }),
        Product.findOne({ 
          where: { id: item.half2ProductId, companyId }, 
          attributes: ["id", "name", "value"],
          include: [{
            model: ProductVariation,
            as: "variations",
            include: [{
              model: ProductVariationOption,
              as: "options"
            }]
          }]
        }),
      ]);
      if (!base || !half1 || !half2) {
        result.push({ ...item, productName: item.productName || "Meio a meio (produto não encontrado)", productValue: 0 });
        continue;
      }
      
      // Obter valores das variações se disponíveis
      let v1 = Number((half1 as any).value) || 0;
      let v2 = Number((half2 as any).value) || 0;
      
      if ((item as any).half1OptionId && (half1 as any).variations && (half1 as any).variations.length > 0) {
        const firstVariation = (half1 as any).variations[0];
        const option = firstVariation?.options?.find((o: any) => o.id === (item as any).half1OptionId);
        if (option) v1 = Number(option.value) || 0;
      }
      
      if ((item as any).half2OptionId && (half2 as any).variations && (half2 as any).variations.length > 0) {
        const firstVariation = (half2 as any).variations[0];
        const option = firstVariation?.options?.find((o: any) => o.id === (item as any).half2OptionId);
        if (option) v2 = Number(option.value) || 0;
      }
      
      const rule = (base as any).halfAndHalfPriceRule || "max";
      let productValue = 0;
      if (rule === "max") productValue = Math.max(v1, v2);
      else if (rule === "fixed") {
        // Para fixed, usar a variação selecionada do produto base se disponível
        const baseOptionId = (item as any).baseOptionId;
        if (baseOptionId && (base as any).variations && (base as any).variations.length > 0) {
          const firstVariation = (base as any).variations[0];
          const option = firstVariation?.options?.find((o: any) => o.id === baseOptionId);
          if (option) {
            productValue = Number(option.value) || 0;
          } else {
            productValue = Number((base as any).value) || 0;
          }
        } else {
          productValue = Number((base as any).value) || 0;
        }
      }
      else if (rule === "average") productValue = (v1 + v2) / 2;
      else productValue = Math.max(v1, v2);
      const productName =
        item.productName ||
        `${(base as any).name} - Metade ${(half1 as any).name} / Metade ${(half2 as any).name}`;
      result.push({
        type: "halfAndHalf",
        productId: item.productId,
        quantity: item.quantity,
        half1ProductId: item.half1ProductId,
        half2ProductId: item.half2ProductId,
        half1OptionId: (item as any).half1OptionId || null,
        half2OptionId: (item as any).half2OptionId || null,
        productName,
        productValue: Math.round(productValue * 100) / 100,
        grupo: item.grupo || (base as any).grupo,
      });
    } else {
      const normalItem = { ...item } as any;
      if (Array.isArray((item as any).addons) && (item as any).addons.length > 0 && item.productId) {
        const product = await Product.findOne({
          where: { id: item.productId, companyId },
          attributes: ["id", "addOnGroupId", "grupo"],
        });
        let addOnGroupId: number | null = product ? (product as any).addOnGroupId : null;
        if (addOnGroupId == null && product && (product as any).grupo) {
          const ga = await GrupoAddOn.findOne({
            where: { companyId, grupo: (product as any).grupo },
            attributes: ["addOnGroupId"],
          });
          if (ga) addOnGroupId = ga.addOnGroupId;
        }
        if (addOnGroupId) {
          const validItems = await AddOnItem.findAll({
            where: { addOnGroupId },
            attributes: ["id", "label", "value"],
          });
          const validMap = new Map(validItems.map((i) => [i.id, i]));
          const validatedAddons: Array<{ addOnItemId: number; label: string; value: number }> = [];
          let addonsTotal = 0;
          for (const a of (item as any).addons) {
            const v = validMap.get(a.addOnItemId);
            if (v) {
              validatedAddons.push({
                addOnItemId: v.id,
                label: a.label ?? v.label,
                value: Number(a.value ?? v.value) || 0,
              });
              addonsTotal += Number(v.value) || 0;
            }
          }
          normalItem.addons = validatedAddons;
          normalItem.addonsTotal = Math.round(addonsTotal * 100) / 100;
        }
      }
      result.push(normalItem);
    }
  }
  return result;
};

const normalizeAnswerValues = (value: string | string[] | undefined): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((v) => String(v ?? "").trim())
      .filter((v) => v !== "");
  }
  const single = String(value ?? "").trim();
  return single ? [single] : [];
};

const resolveTriggeredOrderMessages = (
  rules: OrderTriggerMessageRule[],
  answers: Answer[]
): string[] => {
  const triggered = new Set<string>();
  for (const rule of rules) {
    const expected = String(rule.optionValue || "").trim().toLowerCase();
    const message = String(rule.message || "").trim();
    if (!rule.fieldId || !expected || !message) continue;
    const answer = answers.find((a) => Number(a.fieldId) === Number(rule.fieldId));
    if (!answer) continue;
    const values = normalizeAnswerValues(answer.answer).map((v) => v.toLowerCase());
    if (values.includes(expected)) {
      triggered.add(message);
    }
  }
  return Array.from(triggered);
};

const ProcessFormResponseService = async ({
  formId,
  answers,
  quotationItems,
  menuItems,
  responderPhone,
  responderEmail,
  responderName,
  ipAddress,
  userAgent,
  metadata,
  orderToken,
}: Request): Promise<FormResponse> => {
  // Load form with fields
  const form = await Form.findByPk(formId, {
    include: [
      {
        association: "fields",
        order: [["order", "ASC"]],
      },
    ],
  });

  if (!form) {
    throw new AppError("ERR_FORM_NOT_FOUND", 404);
  }

  // Log para debug - verificar o que foi carregado do banco
  const loadedSettings = form.settings as any;
  console.log("ProcessFormResponseService: Loaded form settings from DB:", JSON.stringify(loadedSettings, null, 2));
  console.log("ProcessFormResponseService: Loaded mesaPrintConfig from DB:", loadedSettings?.mesaPrintConfig);
  console.log("ProcessFormResponseService: Loaded deliveryPrintDeviceIds from DB:", loadedSettings?.deliveryPrintDeviceIds);

  if (!form.isActive) {
    throw new AppError("ERR_FORM_INACTIVE", 400);
  }

  // Validate required fields
  const fields = form.fields || [];
  const requiredFields = fields.filter((f) => f.isRequired);
  
  for (const field of requiredFields) {
    const answer = answers.find((a) => a.fieldId === field.id);
    if (!answer || !answer.answer || 
        (Array.isArray(answer.answer) && answer.answer.length === 0)) {
      throw new AppError(`ERR_FIELD_REQUIRED: ${field.label}`, 400);
    }
  }

  // Extract contact info from answers
  let contactName = responderName || "";
  let contactPhone = responderPhone || "";
  let contactEmail = responderEmail || "";

  const toStr = (v: unknown): string =>
    v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);

  // Try to find name, phone, email in form fields
  for (const answer of answers) {
    const field = fields.find((f) => f.id === answer.fieldId);
    if (field) {
      const fieldMetadata = field.metadata as any;
      const val = toStr(answer.answer).trim();
      if (fieldMetadata?.autoFieldType === "supplierName" || (field.fieldType === "text" && field.label.toLowerCase().includes("nome do fornecedor"))) {
        if (val) contactName = val;
      } else if (fieldMetadata?.autoFieldType === "name" || (field.fieldType === "text" && field.label.toLowerCase().includes("nome"))) {
        if (val) contactName = val;
      }
      if (fieldMetadata?.autoFieldType === "phone" || field.fieldType === "phone") {
        if (val) contactPhone = val;
      }
      if (field.fieldType === "email") {
        if (val) contactEmail = val;
      }
    }
  }

  // Normalizar telefone: só dígitos, garantir 55 para Brasil se tiver 10+ dígitos
  if (contactPhone) {
    contactPhone = normalizeBrazilPhoneForWhatsapp(contactPhone);
  }

  // Check if form is quotation or menu type and process items
  const formSettings = form.settings as any;
  const isQuotationForm = formSettings?.formType === "quotation";
  const isMenuForm = formSettings?.formType === "cardapio";
  const isAgendamentoForm = formSettings?.formType === "agendamento";
  const orderTriggerMessageRules: OrderTriggerMessageRule[] = Array.isArray(formSettings?.orderTriggerMessages)
    ? formSettings.orderTriggerMessages
        .map((rule: any) => ({
          fieldId: Number(rule?.fieldId),
          optionValue: String(rule?.optionValue ?? ""),
          message: String(rule?.message ?? ""),
        }))
        .filter((rule: OrderTriggerMessageRule) => !!rule.fieldId && !!rule.optionValue.trim() && !!rule.message.trim())
    : [];
  const triggeredOrderMessages = resolveTriggeredOrderMessages(orderTriggerMessageRules, answers);

  // Prepare metadata with quotationItems or menuItems if applicable
  const responseMetadata: any = metadata || {};
  if (isAgendamentoForm && metadata) {
    const meta = metadata as any;
    if (meta.appointmentServiceId != null) responseMetadata.appointmentServiceId = meta.appointmentServiceId;
    if (meta.assignedUserId != null) responseMetadata.assignedUserId = meta.assignedUserId;
    if (meta.startTime != null) responseMetadata.startTime = meta.startTime;
    if (meta.endTime != null) responseMetadata.endTime = meta.endTime;
  }
  if (isQuotationForm && quotationItems && quotationItems.length > 0) {
    responseMetadata.quotationItems = quotationItems;
    console.log("ProcessFormResponseService: Saving quotationItems:", quotationItems);
  } else if (isQuotationForm) {
    console.log("ProcessFormResponseService: Form is quotation but no quotationItems received");
  }
  
  let normalizedMenuItems: any[] | null = null;
  if (isMenuForm && menuItems && menuItems.length > 0) {
    normalizedMenuItems = await normalizeMenuItems(menuItems, form.companyId);
    responseMetadata.menuItems = normalizedMenuItems;
    const deliveryFeeFromMeta = Number((metadata as any)?.deliveryFee) || 0;
    let subtotal = 0;
    for (const it of normalizedMenuItems) {
      const pv = Number(it.productValue) || 0;
      const addonsTotal = Number(it.addonsTotal) || 0;
      subtotal += (pv + addonsTotal) * (it.quantity || 0);
    }
    responseMetadata.subtotal = Math.round(subtotal * 100) / 100;
    responseMetadata.total = Math.round((subtotal + deliveryFeeFromMeta) * 100) / 100;
    responseMetadata.deliveryFee = deliveryFeeFromMeta;
    console.log("ProcessFormResponseService: Saving menuItems:", responseMetadata.menuItems);
  } else if (isMenuForm) {
    console.log("ProcessFormResponseService: Form is menu but no menuItems received");
  }
  if (triggeredOrderMessages.length > 0) {
    responseMetadata.triggeredOrderMessages = triggeredOrderMessages;
  }

  // Create FormResponse (orderStatus "novo" for menu/cardapio forms)
  const createPayload: any = {
    formId: form.id,
    responderPhone: contactPhone,
    responderEmail: contactEmail,
    responderName: contactName,
    ipAddress,
    userAgent,
    metadata: responseMetadata,
  };
  if (isMenuForm) {
    // Mesa: pedido pelo garçom → confirmado; pedido direto pelo QR da mesa → novo
    const orderType = (responseMetadata.orderType ?? (metadata as any)?.orderType) as string | undefined;
    const placedByGarcom = !!(responseMetadata.garcomName ?? responseMetadata.placedByGarcom ?? (metadata as any)?.placedByGarcom);
    if (orderType === "mesa" && placedByGarcom) {
      createPayload.orderStatus = "confirmado";
    } else {
      createPayload.orderStatus = "novo";
    }
    // Gerar protocolo único PED-YYYYMMDD-NNNN por empresa/dia
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const count = await FormResponse.count({
      include: [
        {
          model: Form,
          as: "form",
          required: true,
          where: { companyId: form.companyId },
          attributes: [],
        },
      ],
      where: {
        submittedAt: { [Op.between]: [startOfDay, endOfDay] } as any,
      },
    });
    createPayload.protocol = `PED-${dateStr}-${String(count + 1).padStart(4, "0")}`;
  }
  const response = await FormResponse.create(createPayload);

  // Pedido delivery: gerar token único para QR do entregador
  if (isMenuForm && responseMetadata.orderType === "delivery") {
    const scanToken = createDeliveryScanToken(form.companyId, form.id, response.id);
    const updatedMeta = { ...(response.metadata as object || {}), deliveryScanToken: scanToken };
    await response.update({ metadata: updatedMeta });
  }

  // Create ResponseAnswers (normalizar telefones para formato de disparo antes de salvar)
  const answersToCreate = answers.map((answer) => {
    let answerStr = Array.isArray(answer.answer)
      ? answer.answer.join(", ")
      : String(answer.answer);
    const field = fields.find((f) => f.id === answer.fieldId);
    const isPhoneField = field && (
      (field as any).fieldType === "phone" ||
      ((field as any).metadata as any)?.autoFieldType === "phone"
    );
    if (isPhoneField && answerStr) {
      answerStr = normalizeBrazilPhoneForWhatsapp(answerStr);
    }
    return {
      responseId: response.id,
      fieldId: answer.fieldId,
      answer: answerStr,
      answerData: answer.answerData || { value: answer.answer },
      fileUrl: answer.fileUrl,
    };
  });

  await ResponseAnswer.bulkCreate(answersToCreate);

  let contact = null;
  let ticket = null;

  let tableId = (metadata as any)?.tableId ?? (responseMetadata as any)?.tableId;
  if (orderToken) {
    const decoded = verifyOrderToken(orderToken);
    if (!decoded || decoded.formId !== form.id) {
      throw new AppError("ERR_MESA_LINK_INVALID", 403);
    }
    tableId = decoded.mesaId;
  }

  // Reutilizar contact/ticket da mesa quando pedido é para mesa já ocupada (ex.: Garçom adiciona pedido)
  if (isMenuForm && tableId != null) {
    const mesaIdNum = typeof tableId === "string" ? parseInt(tableId, 10) : Number(tableId);
    if (!Number.isNaN(mesaIdNum)) {
      const mesa = await Mesa.findOne({
        where: { id: mesaIdNum, companyId: form.companyId },
      });
      if (mesa && mesa.status === "ocupada" && mesa.contactId) {
        contact = await Contact.findOne({
          where: { id: mesa.contactId, companyId: form.companyId },
        });
        if (contact) {
          ticket = mesa.ticketId
            ? await Ticket.findOne({ where: { id: mesa.ticketId, companyId: form.companyId } })
            : null;
          const updatePayload: { contactId: number; ticketId?: number | null; mesaSessionId?: string } = {
            contactId: contact.id,
            ticketId: ticket?.id ?? null,
          };
          if (mesa.sessionId) updatePayload.mesaSessionId = mesa.sessionId;
          await response.update(updatePayload);
        }
      }
    }
  }

  // Create/Update Contact if configured
  if (form.createContact && contactPhone && !contact) {
    try {
      contact = await CreateOrUpdateContactService({
        name: contactName || "Sem nome",
        number: contactPhone,
        email: contactEmail,
        isGroup: false,
        companyId: form.companyId,
      });
      
      await response.update({ contactId: contact.id });
    } catch (err) {
      console.error("Error creating contact from form:", err);
    }
  }

  // "Peça de novo" / Auto-preenchimento: persistir respostas no contato (ContactCustomFields)
  // Guardamos por label (name = field.label) e deduplicamos removendo os registros anteriores do mesmo name.
  // Apenas quando habilitado em settings.enablePieceAgain e para formType=cardapio.
  const enablePieceAgain = formSettings?.enablePieceAgain === true;
  if (enablePieceAgain && isMenuForm && contact) {
    try {
      const isSensitiveLabel = (label: string) =>
        /cpf|cart[aã]o|card|senha|password|cvv|cvc|token|c[oó]digo|pin/i.test(label || "");

      const toValueString = (val: any) => {
        if (val === undefined || val === null) return "";
        if (Array.isArray(val)) return "__json__:" + JSON.stringify(val);
        return String(val);
      };

      const entries = answers
        .map((answer) => {
          const field = fields.find((f) => f.id === answer.fieldId);
          if (!field) return null;
          const meta = field.metadata as any;
          const label = String(field.label || "").trim();
          if (!label) return null;

          // Não salvar campos automáticos e dados de contato
          if (
            meta?.autoFieldType === "name" ||
            meta?.autoFieldType === "phone" ||
            meta?.autoFieldType === "supplierName" ||
            meta?.autoFieldType === "sellerName"
          ) return null;
          if (field.fieldType === "phone" || field.fieldType === "email") return null;
          if (field.fieldType === "file") return null;
          if (isSensitiveLabel(label)) return null;

          const valueStr = toValueString(answer.answer);
          if (!valueStr || valueStr.trim() === "") return null;
          return { name: label, value: valueStr };
        })
        .filter((x): x is { name: string; value: string } => x !== null);

      if (entries.length > 0) {
        const names = Array.from(new Set(entries.map((e) => e.name)));
        await ContactCustomField.destroy({
          where: {
            contactId: contact.id,
            name: { [Op.in]: names } as any,
          },
        });
        await ContactCustomField.bulkCreate(
          entries.map((e) => ({
            contactId: contact!.id,
            name: e.name,
            value: e.value,
          }))
        );
      }
    } catch (err: any) {
      console.warn("ProcessFormResponseService - Falha ao salvar ContactCustomFields:", err?.message || err);
    }
  }

  // Create Ticket if configured
  if (form.createTicket && contact && !ticket) {
    try {
      // Use form creator as userId, or 0 if not set (ticket will be unassigned)
      const userId = form.createdBy || 0;
      ticket = await CreateTicketService({
        contactId: contact.id,
        status: "pending",
        userId,
        companyId: form.companyId,
      });
      
      await response.update({ ticketId: ticket.id });
    } catch (err) {
      console.error("Error creating ticket from form:", err);
    }
  }

  // Agendamento: criar Appointment e validar slot
  if (isAgendamentoForm) {
    const meta = (response.metadata || responseMetadata) as any;
    const appointmentServiceId = meta?.appointmentServiceId != null ? Number(meta.appointmentServiceId) : null;
    const assignedUserId = meta?.assignedUserId != null ? Number(meta.assignedUserId) : null;
    const startTime = meta?.startTime ? new Date(meta.startTime) : null;
    const endTime = meta?.endTime ? new Date(meta.endTime) : null;

    if (!appointmentServiceId || !assignedUserId || !startTime || !endTime) {
      throw new AppError("ERR_AGENDAMENTO_METADATA_REQUIRED", 400);
    }

    const overlapping = await Appointment.count({
      where: {
        companyId: form.companyId,
        assignedUserId,
        status: { [Op.in]: ["pending", "confirmed"] },
        startTime: { [Op.lt]: endTime },
        endTime: { [Op.gt]: startTime },
      },
    });
    if (overlapping > 0) {
      throw new AppError("ERR_AGENDAMENTO_SLOT_CONFLICT", 409);
    }

    const service = await AppointmentService.findOne({
      where: { id: appointmentServiceId, companyId: form.companyId },
      include: [{ association: "user", attributes: ["id", "name"] }],
    });
    if (!service) {
      throw new AppError("ERR_APPOINTMENT_SERVICE_NOT_FOUND", 404);
    }

    await Appointment.create({
      companyId: form.companyId,
      formId: form.id,
      formResponseId: response.id,
      contactId: contact?.id ?? null,
      appointmentServiceId,
      assignedUserId,
      startTime,
      endTime,
      status: "pending",
      responderName: contactName || null,
      responderPhone: contactPhone || null,
      metadata: responseMetadata,
    });
  }

  // Para cardápio com mesa: garantir contact antes do auto-ocupar (mesmo se createContact estiver desligado)
  if (isMenuForm && tableId != null && !contact && contactPhone) {
    try {
      contact = await CreateOrUpdateContactService({
        name: contactName || "Sem nome",
        number: contactPhone,
        email: contactEmail,
        isGroup: false,
        companyId: form.companyId,
      });
      await response.update({ contactId: contact.id });
      if (form.createTicket) {
        const userId = form.createdBy || 0;
        ticket = await CreateTicketService({
          contactId: contact.id,
          status: "pending",
          userId,
          companyId: form.companyId,
        });
        await response.update({ ticketId: ticket.id });
      }
    } catch (err) {
      console.error("Error ensuring contact for mesa auto-occupy:", err);
    }
  }

  // Auto-ocupação de mesa: quando cliente pede via cardápio com mesa livre (?mesa=X)
  // Verificar se requireMesaOccupation está habilitado (padrão: true para compatibilidade)
  const requireMesaOccupationRaw = formSettings?.requireMesaOccupation;
  const requireMesaOccupation = requireMesaOccupationRaw !== false; // Default true
  console.log("ProcessFormResponseService: requireMesaOccupation check:", {
    raw: requireMesaOccupationRaw,
    final: requireMesaOccupation,
    formSettingsKeys: Object.keys(formSettings || {}),
  });
  
  if (tableId != null && contact) {
    try {
      const mesaId = typeof tableId === "string" ? parseInt(tableId, 10) : Number(tableId);
      if (!Number.isNaN(mesaId)) {
        const mesa = await Mesa.findOne({
          where: { id: mesaId, companyId: form.companyId },
        });
        if (mesa) {
          console.log("ProcessFormResponseService: Mesa found for order:", {
            mesaId: mesa.id,
            mesaStatus: mesa.status,
            requireMesaOccupation,
            willOccupy: requireMesaOccupation && mesa.status === "livre",
          });
          
          if (requireMesaOccupation && mesa.status === "livre") {
            // Modo tradicional: ocupar mesa automaticamente
            console.log("ProcessFormResponseService: Ocupando mesa automaticamente");
            const mesaOcupada = await OcuparMesaService({
              mesaId: mesa.id,
              companyId: form.companyId,
              contactId: contact.id,
              ticketId: ticket?.id,
            });
            const updatedMeta = { ...(response.metadata as object || {}), tableNumber: mesa.name || mesa.number };
            await response.update({
              metadata: updatedMeta,
              ...(mesaOcupada.sessionId && { mesaSessionId: mesaOcupada.sessionId }),
            });
          } else if (!requireMesaOccupation) {
            // Modo sem controle: apenas associar mesa ao pedido sem ocupar
            console.log("ProcessFormResponseService: Modo sem ocupação - apenas associando mesa ao pedido");
            const updatedMeta = { ...(response.metadata as object || {}), tableNumber: mesa.name || mesa.number };
            const updatePayload: any = { metadata: updatedMeta };
            
            // Se mesa já estiver ocupada, usar sessionId existente
            if (mesa.status === "ocupada" && mesa.sessionId) {
              updatePayload.mesaSessionId = mesa.sessionId;
            }
            
            await response.update(updatePayload);
          } else if (mesa.status === "ocupada" && mesa.sessionId) {
            // Mesa já ocupada: associar pedido à sessão existente
            const updatedMeta = { ...(response.metadata as object || {}), tableNumber: mesa.name || mesa.number };
            await response.update({
              metadata: updatedMeta,
              mesaSessionId: mesa.sessionId,
            });
          }
        }
      }
    } catch (err: any) {
      // Não quebrar o fluxo se mesa já ocupada ou outro erro
      console.warn("ProcessFormResponseService - Auto-ocupar mesa:", err?.message || err);
    }
  }

  // Create print job(s) for menu form according to mesaPrintConfig / deliveryPrintDeviceIds
  if (isMenuForm && menuItems && menuItems.length > 0) {
    try {
      const formSettings = form.settings as any;
      console.log("ProcessFormResponseService: formSettings at print job creation:", JSON.stringify(formSettings, null, 2));
      
      const printDeviceId = formSettings?.printDeviceId as number | undefined;
      const mesaPrintConfig = formSettings?.mesaPrintConfig as Array<{ printDeviceId: number; groupNames: string[] }> | undefined;
      const deliveryPrintDeviceIds = formSettings?.deliveryPrintDeviceIds as number[] | undefined;
      
      console.log("ProcessFormResponseService: Extracted values - printDeviceId:", printDeviceId, "mesaPrintConfig:", mesaPrintConfig, "deliveryPrintDeviceIds:", deliveryPrintDeviceIds);

      let meta = (response.metadata || metadata || {}) as Record<string, unknown>;
      if (meta?.orderType === "delivery") {
        const fresh = await FormResponse.findByPk(response.id, { attributes: ["metadata"] });
        if (fresh?.metadata) meta = fresh.metadata as Record<string, unknown>;
        let scanToken = meta?.deliveryScanToken as string | undefined;
        if (!scanToken) {
          scanToken = createDeliveryScanToken(form.companyId, form.id, response.id);
          await response.update({
            metadata: { ...meta, deliveryScanToken: scanToken },
          });
          meta = { ...meta, deliveryScanToken: scanToken };
        }
      }

      const tableNumber = (meta?.tableNumber as string) || "";
      const garcomName = (meta?.garcomName as string) || "";
      const allMenuItems = normalizedMenuItems && normalizedMenuItems.length > 0 ? normalizedMenuItems : menuItems;
      const orderType = meta?.orderType === "delivery" ? "delivery" : "mesa";

      // Payload de impressão: menuItems inclui addons e addonsTotal por item para o agente exibir na comanda
      const buildConteudo = (menuItemsForJob: typeof allMenuItems): Record<string, unknown> => {
        const answersForPrint = answers
          .map((answer) => {
            const field = fields.find((f) => f.id === answer.fieldId);
            return {
              fieldId: answer.fieldId,
              label: field?.label || "",
              answer: answer.answer,
            };
          })
          .concat(
            triggeredOrderMessages.map((message, index) => ({
              fieldId: -(index + 1),
              label: "Mensagem automática",
              answer: message,
            }))
          );
        const conteudo: Record<string, unknown> = {
          event: "form.submitted",
          formId: form.id,
          formName: form.name,
          responseId: response.id,
          protocol: response.protocol,
          submittedAt: response.submittedAt,
          tableNumber,
          garcomName,
          responder: {
            name: contactName,
            phone: contactPhone,
            email: contactEmail,
          },
          answers: answersForPrint,
          menuItems: menuItemsForJob,
        };
        if (orderType === "delivery" && meta?.deliveryScanToken) {
          const token = meta.deliveryScanToken as string;
          conteudo.deliveryScanToken = token;
          const baseUrl = process.env.FRONTEND_URL || process.env.BACKEND_URL || "";
          if (baseUrl) {
            conteudo.deliveryScanUrl = `${baseUrl.replace(/\/$/, "")}/entregador?t=${encodeURIComponent(token)}`;
          }
        }
        return conteudo;
      };

      if (orderType === "delivery") {
        // Configuração de impressão para pedidos de delivery
        const deviceIds: number[] = deliveryPrintDeviceIds?.length
          ? deliveryPrintDeviceIds
          : printDeviceId
            ? [printDeviceId]
            : [];
        
        console.log(`ProcessFormResponseService: Delivery order - printing to ${deviceIds.length} device(s): ${deviceIds.join(", ")}`);
        
        for (const id of deviceIds) {
          if (!id || id <= 0) {
            console.warn(`ProcessFormResponseService: Invalid device ID for delivery: ${id}`);
            continue;
          }
          
          const printDevice = await PrintDevice.findOne({
            where: { id, companyId: form.companyId },
          });
          if (printDevice) {
            console.log(`ProcessFormResponseService: Creating delivery print job for device ${printDevice.deviceId} (deviceId: ${printDevice.deviceId})`);
            await CreateAndDispatchPrintJobService({
              companyId: form.companyId,
              deviceId: printDevice.deviceId,
              formId: form.id,
              formResponseId: response.id,
              conteudo: buildConteudo(allMenuItems),
            });
          } else {
            console.warn(`ProcessFormResponseService: PrintDevice not found for delivery: id=${id}, companyId=${form.companyId}`);
          }
        }
      } else {
        // Configuração de impressão para pedidos de mesa/garçom
        console.log(`ProcessFormResponseService: Raw mesaPrintConfig:`, JSON.stringify(mesaPrintConfig, null, 2));
        
        const config: Array<{ printDeviceId: number; groupNames: string[] }> =
          mesaPrintConfig?.length
            ? mesaPrintConfig
            : printDeviceId
              ? [{ printDeviceId, groupNames: ["*"] }]
              : [];
        
        console.log(`ProcessFormResponseService: Parsed config has ${config.length} row(s):`, config);
        
        // Agrupar grupos por dispositivo (evita duplicação se mesma impressora tem múltiplas linhas)
        const byDevice = new Map<number, Set<string>>();
        for (const row of config) {
          // Validar que printDeviceId existe e é válido
          if (!row.printDeviceId || row.printDeviceId <= 0) {
            console.warn(`ProcessFormResponseService: Invalid printDeviceId in config: ${row.printDeviceId}`);
            continue;
          }
          if (!byDevice.has(row.printDeviceId)) {
            byDevice.set(row.printDeviceId, new Set());
          }
          // Garantir que groupNames é um array
          const groupNamesArray = Array.isArray(row.groupNames) ? row.groupNames : [];
          groupNamesArray.forEach((g) => {
            if (g && g.trim()) {
              byDevice.get(row.printDeviceId)!.add(g.trim());
            }
          });
          console.log(`ProcessFormResponseService: Device ${row.printDeviceId} configured with groups: ${groupNamesArray.join(", ")}`);
        }
        
        // Log dos grupos de cada item do menu para debug
        console.log(`ProcessFormResponseService: Menu items and their groups:`, 
          allMenuItems.map((item: any) => ({
            name: item.productName || item.name,
            grupo: (item.grupo || "Outros").trim() || "Outros"
          }))
        );

        // Processar cada dispositivo configurado
        console.log(`ProcessFormResponseService: Processing mesa order with ${allMenuItems.length} total items`);
        console.log(`ProcessFormResponseService: Config has ${byDevice.size} device(s) configured`);
        
        for (const [devId, groupNames] of byDevice.entries()) {
          const printDevice = await PrintDevice.findOne({
            where: { id: devId, companyId: form.companyId },
          });
          if (!printDevice) {
            console.warn(`ProcessFormResponseService: PrintDevice not found: id=${devId}, companyId=${form.companyId}`);
            continue;
          }
          
          const names = Array.from(groupNames);
          const allGroups = names.includes("*");
          
          console.log(`ProcessFormResponseService: Processing device ${printDevice.deviceId} (id=${devId}) with groups: ${names.join(", ")} (allGroups=${allGroups})`);
          
          // Filtrar itens do menu que pertencem aos grupos configurados para esta impressora
          const filtered = allMenuItems.filter((item: any) => {
            const itemGrupo = (item.grupo || "Outros").trim() || "Outros";
            const matches = allGroups || names.some(g => g.trim().toLowerCase() === itemGrupo.toLowerCase());
            
            if (matches) {
              console.log(`ProcessFormResponseService: Item "${item.productName || item.name}" (grupo="${itemGrupo}") matches device ${printDevice.deviceId}`);
            }
            
            return matches;
          });
          
          if (filtered.length === 0) {
            console.log(`ProcessFormResponseService: No items to print for device ${printDevice.deviceId} (groups: ${names.join(", ")})`);
            continue;
          }
          
          console.log(`ProcessFormResponseService: Creating print job for device ${printDevice.deviceId} (deviceId: ${printDevice.deviceId}) with ${filtered.length} items out of ${allMenuItems.length} total (groups: ${names.join(", ")})`);
          console.log(`ProcessFormResponseService: Filtered items: ${filtered.map((item: any) => `${item.productName || item.name} (${(item.grupo || "Outros").trim()})`).join(", ")}`);
          
          await CreateAndDispatchPrintJobService({
            companyId: form.companyId,
            deviceId: printDevice.deviceId,
            formId: form.id,
            formResponseId: response.id,
            conteudo: buildConteudo(filtered),
          });
        }
      }
    } catch (err) {
      console.error("Error creating print job:", err);
    }
  }

  // Process menu form: send WhatsApp message to customer em segundo plano (não bloqueia a resposta)
  const disableWhatsAppMessages = formSettings?.disableWhatsAppMessages === true;
  console.log("ProcessFormResponseService - Checking menu form:", {
    isMenuForm,
    menuItemsCount: menuItems?.length || 0,
    contactPhone: contactPhone ? "present" : "missing",
    disableWhatsAppMessages,
  });

  if (isMenuForm && menuItems && menuItems.length > 0 && contactPhone && !disableWhatsAppMessages) {
    (async () => {
      try {
        console.log("ProcessFormResponseService (background) - Starting WhatsApp send");
        const formSettings = form.settings as any;
        const selectedWhatsappId = formSettings?.whatsappId;
        let whatsappToUse;
        if (selectedWhatsappId) {
          const Whatsapp = (await import("../../models/Whatsapp")).default;
          whatsappToUse = await Whatsapp.findOne({
            where: { id: selectedWhatsappId, companyId: form.companyId, status: "CONNECTED" },
          });
          if (!whatsappToUse) whatsappToUse = await GetDefaultWhatsApp(form.companyId);
        } else {
          whatsappToUse = await GetDefaultWhatsApp(form.companyId);
        }
        if (!whatsappToUse) {
          console.warn("ProcessFormResponseService (background) - Nenhuma conexão WhatsApp disponível");
          return;
        }
        let contactForSend = contact;
        if (!contactForSend && contactPhone) {
          contactForSend = await CreateOrUpdateContactService({
            name: contactName || "Sem nome",
            number: contactPhone,
            email: contactEmail,
            isGroup: false,
            companyId: form.companyId,
          });
        }
        if (!contactForSend) return;
        // Garantir número normalizado (12 dígitos) no contato antes do envio: contato de mesa pode ter 13 dígitos
        if (contactPhone && contactForSend.number !== contactPhone) {
          await contactForSend.update({ number: contactPhone });
        }
        const ticket = await FindOrCreateTicketService(
          contactForSend,
          whatsappToUse.id,
          0,
          form.companyId
        );
        const customFields = answers
          .map((answer) => {
            const field = fields.find((f) => f.id === answer.fieldId);
            if (field) {
              const fieldMetadata = field.metadata as any;
              if (
                fieldMetadata?.autoFieldType === "name" ||
                fieldMetadata?.autoFieldType === "phone" ||
                field.fieldType === "phone"
              ) return null;
              return {
                label: field.label,
                answer: typeof answer.answer === "string" ? answer.answer : String(answer.answer),
              };
            }
            return null;
          })
          .filter((f): f is { label: string; answer: string } => f !== null);
        if (triggeredOrderMessages.length > 0) {
          customFields.push(
            ...triggeredOrderMessages.map((message) => ({
              label: "Mensagem automática",
              answer: message,
            }))
          );
        }
        const meta = (response.metadata || metadata || {}) as Record<string, unknown>;
        const tableNumberMsg = (meta?.tableNumber as string) || undefined;
        const garcomNameMsg = (meta?.garcomName as string) || undefined;
        const deliveryFee = meta?.deliveryFee != null ? Number(meta.deliveryFee) : undefined;
        const total = meta?.total != null ? Number(meta.total) : undefined;
        const orderMessage = await FormatMenuOrderMessage({
          menuItems: normalizedMenuItems && normalizedMenuItems.length > 0 ? normalizedMenuItems : menuItems,
          customerName: contactName || "Cliente",
          customerPhone: contactPhone,
          customFields,
          protocol: response.protocol || undefined,
          tableNumber: tableNumberMsg,
          garcomName: garcomNameMsg,
          deliveryFee: deliveryFee,
          total: total,
        });
        const sentMessage = await SendWhatsAppMessage({ body: orderMessage, ticket });
        if (sentMessage) {
          console.log("ProcessFormResponseService (background) - WhatsApp message sent", { messageId: sentMessage?.key?.id });
        }
      } catch (err: any) {
        console.error("ProcessFormResponseService (background) - Error sending WhatsApp:", err?.message);
      }
    })();
  }

  if (isAgendamentoForm && contactPhone) {
    (async () => {
      try {
        const { getIO } = await import("../../libs/socket");
        const appointment = await Appointment.findOne({
          where: { formResponseId: response.id, companyId: form.companyId },
          include: [
            { association: "appointmentService", attributes: ["id", "name"] },
            { association: "assignedUser", attributes: ["id", "name"] },
          ],
        });
        if (!appointment) return;
        const formSettings = form.settings as any;
        const selectedWhatsappId = formSettings?.whatsappId;
        let whatsappToUse;
        if (selectedWhatsappId) {
          const Whatsapp = (await import("../../models/Whatsapp")).default;
          whatsappToUse = await Whatsapp.findOne({
            where: { id: selectedWhatsappId, companyId: form.companyId, status: "CONNECTED" },
          });
          if (!whatsappToUse) whatsappToUse = await GetDefaultWhatsApp(form.companyId);
        } else {
          whatsappToUse = await GetDefaultWhatsApp(form.companyId);
        }
        if (!whatsappToUse) return;
        let contactForSend = contact;
        if (!contactForSend && contactPhone) {
          contactForSend = await CreateOrUpdateContactService({
            name: contactName || "Sem nome",
            number: contactPhone,
            email: contactEmail,
            isGroup: false,
            companyId: form.companyId,
          });
        }
        if (!contactForSend) return;
        const ticket = await FindOrCreateTicketService(
          contactForSend,
          whatsappToUse.id,
          0,
          form.companyId
        );
        const serviceName = (appointment as any).appointmentService?.name || "Serviço";
        const professionalName = (appointment as any).assignedUser?.name || "Profissional";
        const baseUrl = process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || "";
        const token = createAppointmentToken(appointment.id);
        const cancelUrl = baseUrl ? `${baseUrl}/f/${form.slug}/cancelar?token=${token}` : undefined;
        const rescheduleUrl = baseUrl ? `${baseUrl}/f/${form.slug}/reagendar?token=${token}` : undefined;
        const msg = FormatAppointmentConfirmationMessage({
          serviceName,
          professionalName,
          startTime: appointment.startTime,
          endTime: appointment.endTime,
          customerName: contactName || "Cliente",
          cancelUrl,
          rescheduleUrl,
        });
        await SendWhatsAppMessage({ body: msg, ticket });
        getIO().to(`company-${form.companyId}-mainchannel`).emit(`company-${form.companyId}-appointment`, { action: "create" });
      } catch (err: any) {
        console.error("ProcessFormResponseService (background) - Agendamento WhatsApp:", err?.message);
      }
    })();
  }

  await response.reload({
    include: [
      { association: "answers", include: [{ association: "field" }] },
      { association: "contact" },
      { association: "ticket" },
    ],
  });

  // Envio WhatsApp é em segundo plano; frontend não deve bloquear (ou desabilitado por configuração)
  if (isMenuForm) {
    (response as any).whatsappSent = disableWhatsAppMessages ? false : "pending";
  }

  // For agendamento form, attach token so frontend can show success page links (reagendar, ical)
  if (isAgendamentoForm) {
    const apt = await Appointment.findOne({
      where: { formResponseId: response.id, companyId: form.companyId },
    });
    if (apt) {
      (response as any).appointmentToken = createAppointmentToken(apt.id);
      (response as any).appointmentId = apt.id;
    }
  }

  return response;
};

export default ProcessFormResponseService;
