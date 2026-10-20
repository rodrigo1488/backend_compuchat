import { Response } from "express";
import { PrintDeviceAuthRequest } from "../middleware/isPrintDeviceAuth";
import BuildPosCatalogService from "../services/UniplusServices/BuildPosCatalogService";
import LiberarMesaService from "../services/MesaServices/LiberarMesaService";
import {
  beginMesaOccupation,
  confirmMesaOccupation,
  resolveOccupationContact,
} from "../services/MesaServices/MesaOccupationFlowService";
import AppError from "../errors/AppError";
import { getIO } from "../libs/socket";

export const catalog = async (
  req: PrintDeviceAuthRequest,
  res: Response
): Promise<Response> => {
  const companyId = Number(req.companyId);
  const data = await BuildPosCatalogService({ companyId });
  return res.status(200).json(data);
};

const contactPhoneOf = (mesa: { contact?: { number?: string | null } | null }): string | null => {
  const number = String(mesa.contact?.number || "");
  if (!number || number.startsWith("SEMTELEFONE-")) return null;
  return number;
};

export const ocupar = async (
  req: PrintDeviceAuthRequest,
  res: Response
): Promise<Response> => {
  const companyId = Number(req.companyId);
  const mesaId = Number(req.params.id);
  const customerName = String(req.body?.customerName || "").trim();
  const phone = String(req.body?.phone || "").trim();
  const userId = Number(req.body?.userId);
  if (!customerName) {
    throw new AppError("ERR_CONTACT_REQUIRED", 400);
  }

  const contact = await resolveOccupationContact({
    companyId,
    name: customerName,
    phone: phone || null,
  });

  const result = await beginMesaOccupation({
    mesaId,
    companyId,
    contactId: contact.id,
    transferir: req.body?.transferir !== false,
    userId: Number.isFinite(userId) ? userId : undefined,
    forceKeyword: req.body?.forceKeyword === true,
  });

  if (result.status === "pending_confirmation") {
    return res.status(202).json({
      ...result,
      contactName: customerName,
      contactPhone: contact.number?.startsWith("SEMTELEFONE-") ? null : contact.number,
    });
  }

  const { mesa } = result;
  const io = getIO();
  io.to(`company-${companyId}-mainchannel`).emit(`company-${companyId}-mesa`, {
    action: "ocupar",
    mesa,
  });

  return res.status(200).json({
    id: mesa.id,
    status: mesa.status,
    contactName: customerName,
    contactPhone: contactPhoneOf(mesa),
  });
};

export const confirmarOcupacao = async (
  req: PrintDeviceAuthRequest,
  res: Response
): Promise<Response> => {
  const companyId = Number(req.companyId);
  const mesaId = Number(req.params.id);
  const mesa = await confirmMesaOccupation({
    mesaId,
    companyId,
    keyword: req.body?.keyword,
  });

  const io = getIO();
  io.to(`company-${companyId}-mainchannel`).emit(`company-${companyId}-mesa`, {
    action: "ocupar",
    mesa,
  });

  return res.status(200).json({
    status: "confirmed",
    id: mesa.id,
    mesaStatus: mesa.status,
    contactName: mesa.contact?.name || null,
    contactPhone: contactPhoneOf(mesa),
  });
};

export const liberar = async (
  req: PrintDeviceAuthRequest,
  res: Response
): Promise<Response> => {
  const companyId = Number(req.companyId);
  const mesaId = Number(req.params.id);
  const mesa = await LiberarMesaService({ mesaId, companyId });

  const io = getIO();
  io.to(`company-${companyId}-mainchannel`).emit(`company-${companyId}-mesa`, {
    action: "liberar",
    mesa,
  });

  return res.status(200).json({
    id: mesa.id,
    status: mesa.status,
  });
};
