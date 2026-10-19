import { UniqueConstraintError } from "sequelize";
import { v4 as uuidv4 } from "uuid";
import AppError from "../../errors/AppError";
import Contact from "../../models/Contact";
import Form from "../../models/Form";
import Mesa from "../../models/Mesa";
import MesaOccupationConfirmation from "../../models/MesaOccupationConfirmation";
import Ticket from "../../models/Ticket";
import User from "../../models/User";
import GetOrCreateDefaultCardapioFormService from "../FormServices/GetOrCreateDefaultCardapioFormService";
import CreateTicketService from "../TicketServices/CreateTicketService";
import SendWhatsAppMessage from "../WbotServices/SendWhatsAppMessage";
import OcuparMesaService from "./OcuparMesaService";

const MESA_OCCUPATION_KEYWORD_EXPIRES_MINUTES = 10;
const KEYWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface PendingOccupation {
  status: "pending_confirmation";
  mesaId: number;
  confirmationId: number;
  expiresAt: Date;
  message: string;
}

export interface OccupiedOccupation {
  status: "occupied";
  mesa: Mesa;
}

const generateOccupationKeyword = (length = 6): string => {
  let keyword = "";
  for (let i = 0; i < length; i += 1) {
    keyword += KEYWORD_ALPHABET[Math.floor(Math.random() * KEYWORD_ALPHABET.length)];
  }
  return keyword;
};

const isPlaceholderPhone = (number?: string | null): boolean =>
  !number || number.startsWith("SEMTELEFONE-");

export const normalizeOccupationPhone = (raw?: string | null): string => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  let number = digits;
  if (number.length === 10 || number.length === 11) {
    number = `55${number}`;
  }
  if (!number.startsWith("55") || number.length < 12 || number.length > 13) {
    throw new AppError("ERR_INVALID_PHONE", 400);
  }
  return number;
};

const isKeywordValidationEnabled = async (
  mesa: Mesa,
  createdBy?: number
): Promise<boolean> => {
  let form: Form | null = null;
  if (mesa.formId) {
    form = await Form.findOne({
      where: { id: mesa.formId, companyId: mesa.companyId, isActive: true },
      attributes: ["id", "settings"],
    });
  }
  if (!form) {
    form = await GetOrCreateDefaultCardapioFormService({
      companyId: mesa.companyId,
      createdBy,
    });
  }
  const settings = (form.settings || {}) as Record<string, unknown>;
  return settings.mesaOccupationKeywordValidation === true;
};

const resolveTicketUserId = async (
  companyId: number,
  userId?: number | null
): Promise<number> => {
  if (userId && userId > 0) {
    const user = await User.findOne({
      where: { id: userId, companyId },
      attributes: ["id"],
    });
    if (user) return user.id;
  }
  const fallback = await User.findOne({
    where: { companyId },
    attributes: ["id"],
    order: [["id", "ASC"]],
  });
  if (!fallback) {
    throw new AppError("ERR_NO_USER_FOUND", 400);
  }
  return fallback.id;
};

export const resolveOccupationContact = async ({
  companyId,
  name,
  phone,
}: {
  companyId: number;
  name: string;
  phone?: string | null;
}): Promise<Contact> => {
  const number = normalizeOccupationPhone(phone);
  if (!number) {
    return Contact.create({
      name,
      number: `SEMTELEFONE-${companyId}-${uuidv4()}`,
      email: "",
      companyId,
      userId: null,
      profilePicUrl: "",
      isGroup: false,
      disableBot: true,
    } as any);
  }

  const existing = await Contact.findOne({
    where: { number, companyId },
    attributes: ["id", "name", "number"],
  });
  if (existing) {
    if (name && existing.name !== name) {
      await existing.update({ name });
    }
    return existing;
  }

  try {
    return await Contact.create({
      name,
      number,
      email: "",
      companyId,
      userId: null,
      profilePicUrl: "",
      isGroup: false,
      disableBot: true,
    } as any);
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const again = await Contact.findOne({
        where: { number, companyId },
        attributes: ["id", "name", "number"],
      });
      if (again) return again;
      throw new AppError("ERR_CONTACT_NUMBER_IN_USE", 409);
    }
    throw err;
  }
};

export const beginMesaOccupation = async ({
  mesaId,
  companyId,
  contactId,
  ticketId,
  transferir = false,
  userId,
}: {
  mesaId: number;
  companyId: number;
  contactId: number;
  ticketId?: number | null;
  transferir?: boolean;
  userId?: number | null;
}): Promise<PendingOccupation | OccupiedOccupation> => {
  const mesaEntity = await Mesa.findOne({
    where: { id: mesaId, companyId },
    attributes: ["id", "companyId", "formId", "status"],
  });
  if (!mesaEntity) {
    throw new AppError("ERR_MESA_NOT_FOUND", 404);
  }

  const resolvedContact = await Contact.findOne({
    where: { id: contactId, companyId },
    attributes: ["id", "name", "number"],
  });
  if (!resolvedContact) {
    throw new AppError("ERR_CONTACT_NOT_FOUND", 404);
  }

  const keywordValidationEnabled = await isKeywordValidationEnabled(
    mesaEntity,
    userId && userId > 0 ? userId : undefined
  );
  const shouldSendKeyword =
    keywordValidationEnabled && !isPlaceholderPhone(resolvedContact.number);

  if (shouldSendKeyword) {
    if (mesaEntity.status === "ocupada") {
      throw new AppError("ERR_MESA_ALREADY_OCCUPIED", 400);
    }

    const ticketUserId = await resolveTicketUserId(companyId, userId);
    let messageTicket: Ticket | null = null;
    if (ticketId && Number.isFinite(Number(ticketId))) {
      messageTicket = await Ticket.findOne({
        where: { id: Number(ticketId), companyId },
        include: [{ association: "contact" }],
      });
    }

    if (!messageTicket) {
      messageTicket = await CreateTicketService({
        contactId: resolvedContact.id,
        status: "open",
        userId: ticketUserId,
        companyId,
        reuseOpenTicket: true,
      });
      await messageTicket.reload({ include: [{ association: "contact" }] });
    }

    const keyword = generateOccupationKeyword(6);
    const expiresAt = new Date(
      Date.now() + MESA_OCCUPATION_KEYWORD_EXPIRES_MINUTES * 60 * 1000
    );

    await MesaOccupationConfirmation.update(
      { status: "cancelled" },
      {
        where: {
          mesaId: mesaEntity.id,
          companyId,
          status: "pending",
        },
      }
    );

    const confirmation = await MesaOccupationConfirmation.create({
      mesaId: mesaEntity.id,
      companyId,
      contactId: resolvedContact.id,
      ticketId: messageTicket.id,
      transferir: !!transferir,
      keyword,
      status: "pending",
      expiresAt,
    });

    await SendWhatsAppMessage({
      ticket: messageTicket,
      body: `Confirmação de ocupação de mesa\n\nSua palavra-chave é: *${keyword}*\n\nInforme esta palavra ao atendente para liberar a ocupação.\nValidade: ${MESA_OCCUPATION_KEYWORD_EXPIRES_MINUTES} minutos.`,
    });

    return {
      status: "pending_confirmation",
      mesaId: mesaEntity.id,
      confirmationId: confirmation.id,
      expiresAt: confirmation.expiresAt,
      message: "Palavra-chave enviada para o WhatsApp do cliente.",
    };
  }

  const mesa = await OcuparMesaService({
    mesaId: mesaEntity.id,
    companyId,
    contactId: resolvedContact.id,
    ticketId: ticketId || undefined,
    transferir: !!transferir,
  });

  return { status: "occupied", mesa };
};

export const confirmMesaOccupation = async ({
  mesaId,
  companyId,
  keyword,
}: {
  mesaId: number;
  companyId: number;
  keyword?: string | null;
}): Promise<Mesa> => {
  const normalizedKeyword = String(keyword || "").trim().toUpperCase();
  if (!normalizedKeyword) {
    throw new AppError("ERR_MESA_KEYWORD_REQUIRED", 400);
  }

  const confirmation = await MesaOccupationConfirmation.findOne({
    where: {
      mesaId,
      companyId,
      status: "pending",
    },
    order: [["createdAt", "DESC"]],
  });

  if (!confirmation) {
    throw new AppError("ERR_MESA_OCCUPATION_CONFIRMATION_NOT_FOUND", 404);
  }

  if (confirmation.expiresAt && new Date(confirmation.expiresAt).getTime() < Date.now()) {
    await confirmation.update({ status: "expired" });
    throw new AppError("ERR_MESA_OCCUPATION_CONFIRMATION_EXPIRED", 400);
  }

  if (confirmation.keyword !== normalizedKeyword) {
    await confirmation.update({ attempts: (confirmation.attempts || 0) + 1 });
    throw new AppError("ERR_MESA_OCCUPATION_KEYWORD_INVALID", 400);
  }

  const mesa = await OcuparMesaService({
    mesaId,
    companyId,
    contactId: confirmation.contactId,
    ticketId: confirmation.ticketId || undefined,
    transferir: !!confirmation.transferir,
  });

  await confirmation.update({
    status: "confirmed",
    confirmedAt: new Date(),
  });

  return mesa;
};
