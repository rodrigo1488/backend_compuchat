import { Request, Response } from "express";
import { Op } from "sequelize";
import Form from "../models/Form";
import FormResponse from "../models/FormResponse";
import User from "../models/User";
import AppError from "../errors/AppError";
import { getIO } from "../libs/socket";
import { verifyDeliveryScanToken, createDeliveryScanToken } from "../helpers/MesaLinkSign";
import UpdateOrderStatusService from "../services/OrderServices/UpdateOrderStatusService";
import SendOrderStatusNotificationService from "../services/OrderServices/SendOrderStatusNotificationService";
import SendOrderEvaluationService from "../services/OrderServices/SendOrderEvaluationService";
import RegisterGourmetVendaService from "../services/GourmetFinanceiroServices/RegisterGourmetVendaService";

const calcTotalFromMenuItems = (metadata: any): number => {
  const items = metadata?.menuItems || [];
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum: number, item: any) => {
    const qty = Number(item.quantity) || 0;
    const val = Number(item.productValue) ?? 0;
    return sum + qty * val;
  }, 0);
};

/** GET /delivery/order-by-token?t=TOKEN - Valida token de scan e retorna dados do pedido (entregador). */
export const orderByToken = async (req: Request, res: Response): Promise<Response> => {
  const { t: token } = req.query;
  const { companyId } = req.user;

  if (!token || typeof token !== "string") {
    throw new AppError("ERR_DELIVERY_TOKEN_REQUIRED", 400);
  }

  const decoded = verifyDeliveryScanToken(token);
  if (!decoded || decoded.companyId !== companyId) {
    throw new AppError("ERR_DELIVERY_TOKEN_INVALID", 400);
  }

  const response = await FormResponse.findOne({
    where: {
      id: decoded.formResponseId,
      formId: decoded.formId,
    },
    include: [
      { association: "form", attributes: ["id", "name", "companyId"] },
    ],
  });

  if (!response || (response.form as Form)?.companyId !== companyId) {
    throw new AppError("ERR_RESPONSE_NOT_FOUND", 404);
  }

  const meta = (response.metadata || {}) as Record<string, unknown>;
  if (meta?.orderType !== "delivery") {
    throw new AppError("ERR_ORDER_NOT_DELIVERY", 400);
  }
  if (response.orderStatus === "entregue") {
    throw new AppError("ERR_ORDER_ALREADY_DELIVERED", 400);
  }

  return res.json({
    id: response.id,
    formId: response.formId,
    protocol: response.protocol,
    orderStatus: response.orderStatus,
    responderName: response.responderName,
    responderPhone: response.responderPhone,
    submittedAt: response.submittedAt,
    metadata: response.metadata,
  });
};

/** POST /delivery/iniciar-rota - Marca pedidos como saiu_entrega e define entregador. */
export const iniciarRota = async (req: Request, res: Response): Promise<Response> => {
  const { formResponseIds } = req.body;
  const { companyId, id: userId } = req.user;

  if (!Array.isArray(formResponseIds) || formResponseIds.length === 0) {
    throw new AppError("ERR_FORM_RESPONSE_IDS_REQUIRED", 400);
  }

  const user = await User.findByPk(userId, { attributes: ["name"] });
  const userName = user?.name ?? "";

  const ids = formResponseIds.map((id: number) => Number(id)).filter((id: number) => !Number.isNaN(id));
  const responses = await FormResponse.findAll({
    where: { id: { [Op.in]: ids } },
    include: [{ association: "form" }],
  });

  const io = getIO();
  let updated = 0;
  for (const r of responses) {
    const form = r.form as Form;
    if (!form || form.companyId !== companyId) continue;
    const meta = (r.metadata || {}) as Record<string, unknown>;
    if (meta?.orderType !== "delivery") continue;
    if (r.orderStatus === "entregue") continue;

    const newMeta = { ...meta, entregadorUserId: userId, entregadorName: userName || "" };
    await r.update({
      metadata: newMeta,
      orderStatus: "saiu_entrega",
    });
    await SendOrderStatusNotificationService({
      form,
      response: r,
      newStatus: "saiu_entrega",
    });
    const reloaded = await r.reload({ include: [{ association: "form" }] });
    io.to(`company-${companyId}-mainchannel`).emit(`company-${companyId}-formResponse`, {
      action: "update",
      response: reloaded,
    });
    updated += 1;
  }

  return res.json({ ok: true, updated });
};

/** POST /delivery/finalizar-rota - Marca pedidos como entregue, envia mensagem de entrega e avaliação. */
export const finalizarRota = async (req: Request, res: Response): Promise<Response> => {
  const { formResponseIds } = req.body;
  const { companyId } = req.user;

  if (!Array.isArray(formResponseIds) || formResponseIds.length === 0) {
    throw new AppError("ERR_FORM_RESPONSE_IDS_REQUIRED", 400);
  }

  const ids = formResponseIds.map((id: number) => Number(id)).filter((id: number) => !Number.isNaN(id));
  const responses = await FormResponse.findAll({
    where: { id: { [Op.in]: ids } },
    include: [
      { association: "form" },
      { association: "contact" },
      { association: "answers", include: [{ association: "field" }] },
    ],
  });

  const io = getIO();

  for (const r of responses) {
    const form = r.form as Form;
    if (!form || form.companyId !== companyId) continue;
    const meta = (r.metadata || {}) as Record<string, unknown>;
    if (meta?.orderType !== "delivery") continue;

    await r.update({ orderStatus: "entregue" });
    const valor = calcTotalFromMenuItems(r.metadata);
    if (valor > 0) {
      try {
        await RegisterGourmetVendaService({
          companyId: form.companyId,
          tipo: "delivery",
          valor,
          formResponseId: r.id,
          protocol: (r as any).protocol ?? null,
          entregadorUserId: (meta.entregadorUserId as number) ?? null,
          entregadorNome: (meta.entregadorName as string) ?? null,
        });
      } catch (err) {
        console.error("RegisterGourmetVendaService (delivery finalizarRota):", err);
      }
    }
    await SendOrderStatusNotificationService({
      form,
      response: r,
      newStatus: "entregue",
    });
    await SendOrderEvaluationService({ form, response: r });

    const updated = await r.reload({ include: [{ association: "form" }] });
    io.to(`company-${companyId}-mainchannel`).emit(`company-${companyId}-formResponse`, {
      action: "update",
      response: updated,
    });
  }

  return res.json({ ok: true, updated: responses.length });
};

/** GET /delivery/scan-token/:formId/:responseId - Gera token para QR do pedido (autenticado). */
export const getScanToken = async (req: Request, res: Response): Promise<Response> => {
  const { formId, responseId } = req.params;
  const { companyId } = req.user;

  const form = await Form.findOne({ where: { id: formId, companyId } });
  if (!form) throw new AppError("ERR_FORM_NOT_FOUND", 404);

  const response = await FormResponse.findOne({
    where: { id: responseId, formId },
  });
  if (!response) throw new AppError("ERR_RESPONSE_NOT_FOUND", 404);

  const meta = (response.metadata || {}) as Record<string, unknown>;
  if (meta?.orderType !== "delivery") {
    throw new AppError("ERR_ORDER_NOT_DELIVERY", 400);
  }

  const token = createDeliveryScanToken(companyId, Number(formId), response.id);
  return res.json({ token });
};
