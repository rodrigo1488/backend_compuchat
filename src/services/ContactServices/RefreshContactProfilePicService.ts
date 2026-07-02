import AppError from "../../errors/AppError";
import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import GetTicketWbot from "../../helpers/GetTicketWbot";
import GetDefaultWhatsApp from "../../helpers/GetDefaultWhatsApp";
import { getWbot } from "../../libs/wbot";
import {
  toWhatsAppGroupJid,
  toWhatsAppPrivateJid
} from "../../helpers/chatJid";
import { sanitizeContactProfilePicUrl } from "../../helpers/contactProfilePic";
import ShowContactService from "./ShowContactService";
import { forceRefreshContactProfilePic } from "./ContactProfilePicService";

const resolveWbotForContact = async (
  contact: Contact,
  companyId: number
) => {
  const ticket = await Ticket.findOne({
    where: { contactId: contact.id, companyId },
    order: [["updatedAt", "DESC"]]
  });

  if (ticket) {
    const wbot = await GetTicketWbot(ticket);
    if (wbot) {
      return wbot;
    }
  }

  const defaultWhatsapp = await GetDefaultWhatsApp(companyId);
  return getWbot(defaultWhatsapp.id);
};

const RefreshContactProfilePicService = async (
  contactId: number,
  companyId: number
): Promise<Contact> => {
  const contact = await ShowContactService(contactId, companyId);

  if (contact.isGroup) {
    throw new AppError("Não é possível atualizar foto de grupo por este atalho", 400);
  }

  const wbot = await resolveWbotForContact(contact, companyId);
  const jid = contact.isGroup
    ? toWhatsAppGroupJid(contact.number)
    : toWhatsAppPrivateJid(contact.number);
  const safeNumber = contact.number.replace(/\D/g, "") || contact.number;

  await forceRefreshContactProfilePic(
    wbot,
    jid,
    companyId,
    safeNumber,
    contact.id
  );

  await contact.reload();

  contact.profilePicUrl = sanitizeContactProfilePicUrl(contact.profilePicUrl);
  return contact;
};

export default RefreshContactProfilePicService;
