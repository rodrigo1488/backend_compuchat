import { Request, Response } from "express";
import { getWbot } from "../libs/wbot";
import ShowWhatsAppService from "../services/WhatsappService/ShowWhatsAppService";
import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
import UpdateWhatsAppService from "../services/WhatsappService/UpdateWhatsAppService";
import CloseTicketsByWhatsAppIdService from "../services/TicketServices/CloseTicketsByWhatsAppIdService";

const store = async (req: Request, res: Response): Promise<Response> => {
  const { whatsappId } = req.params;
  const { companyId } = req.user;

  const whatsapp = await ShowWhatsAppService(whatsappId, companyId);
  
  // Não iniciar sessão Baileys para Instagram ou Gupshup
  if (whatsapp.type !== "instagram" && whatsapp.provider !== "gupshup") {
    await StartWhatsAppSession(whatsapp, companyId);
  } else {
    return res.status(400).json({ 
      message: "Esta conexão não requer inicialização de sessão (Instagram/Gupshup)." 
    });
  }

  return res.status(200).json({ message: "Starting session." });
};

const update = async (req: Request, res: Response): Promise<Response> => {
  const { whatsappId } = req.params;
  const { companyId } = req.user;

  const { whatsapp } = await UpdateWhatsAppService({
    whatsappId,
    companyId,
    whatsappData: { session: "" }
  });

  // Não iniciar sessão Baileys para Instagram ou Gupshup
  if (whatsapp.type !== "instagram" && whatsapp.provider !== "gupshup") {
    await StartWhatsAppSession(whatsapp, companyId);
  } else {
    return res.status(400).json({ 
      message: "Esta conexão não requer reinicialização de sessão (Instagram/Gupshup)." 
    });
  }

  return res.status(200).json({ message: "Starting session." });
};

const remove = async (req: Request, res: Response): Promise<Response> => {
  const { whatsappId } = req.params;
  const { companyId } = req.user;
  const whatsapp = await ShowWhatsAppService(whatsappId, companyId);

  await whatsapp.update({ status: "DISCONNECTED", session: "" });
  await CloseTicketsByWhatsAppIdService(whatsapp.id);

  if (whatsapp.session) {
    const wbot = getWbot(whatsapp.id);
    await wbot.logout();
  }

  return res.status(200).json({ message: "Session disconnected." });
};

export default { store, remove, update };
