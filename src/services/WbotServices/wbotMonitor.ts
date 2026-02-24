import {
  WASocket,
  BinaryNode,
  Contact as BContact,
} from "baileys";
import * as Sentry from "@sentry/node";

import { Op } from "sequelize";
// import { getIO } from "../../libs/socket";
import { Store } from "../../libs/store";
import Contact from "../../models/Contact";
import Setting from "../../models/Setting";
import Ticket from "../../models/Ticket";
import Whatsapp from "../../models/Whatsapp";
import { logger } from "../../utils/logger";
import createOrUpdateBaileysService from "../BaileysServices/CreateOrUpdateBaileysService";
import CreateMessageService from "../MessageServices/CreateMessageService";
import Company from "../../models/Company";

type Session = WASocket & {
  id?: number;
  store?: Store;
};

interface IContact {
  contacts: BContact[];
}

const wbotMonitor = async (
  wbot: Session,
  whatsapp: Whatsapp,
  companyId: number
): Promise<void> => {
  try {
    // Armazenar timestamps das chamadas oferecidas para detectar rejeições rápidas
    const callOffers = new Map<string, number>();

    wbot.ws.on("CB:call", async (node: BinaryNode) => {
      const content = node.content[0] as any;

      if (content.tag === "offer") {
        const { from, id } = node.attrs;
        // Armazenar timestamp quando a chamada é oferecida
        if (id) {
          callOffers.set(id, Date.now());
        }
      }

      if (content.tag === "terminate") {
        const callId = content.attrs?.["call-id"] || node.attrs?.id;
        
        // Verificar se a chamada foi rejeitada
        // Uma chamada rejeitada geralmente termina muito rapidamente (< 2 segundos)
        const offerTime = callId ? callOffers.get(callId) : null;
        const isRejected = offerTime && (Date.now() - offerTime) < 2000;
        
        // Também verificar atributos que indicam rejeição
        const callReason = content.attrs?.reason || node.attrs?.reason || "";
        const duration = content.attrs?.["duration"] ? parseInt(content.attrs["duration"]) : null;
        const isRejectedByReason = callReason === "reject" || callReason === "timeout" || 
                                  duration === 0 || duration === null;
        
        // Se a chamada foi rejeitada, não criar mensagem no chat
        if (isRejected || isRejectedByReason) {
          logger.info(`Chamada rejeitada detectada (reason: ${callReason}, duration: ${duration}, tempo: ${offerTime ? Date.now() - offerTime : 'N/A'}ms), não criando mensagem no chat.`);
          // Limpar registro da chamada
          if (callId) {
            callOffers.delete(callId);
          }
          return;
        }
        
        // Limpar registro da chamada após processamento
        if (callId) {
          callOffers.delete(callId);
        }

        const sendMsgCall = await Setting.findOne({
          where: { key: "call", companyId },
        });

        const translatedMessage = {
          'pt': "*Mensagem Automática:*\n\nAs chamadas de voz e vídeo estão desabilitas para esse WhatsApp, favor enviar uma mensagem de texto. Obrigado",
          'en': "*Automatic Message:*\n\nVoice and video calls are disabled for this WhatsApp, please send a text message. Thank you",
          'es': "*Mensaje Automático:*\n\nLas llamadas de voz y video están deshabilitadas para este WhatsApp, por favor envía un mensaje de texto. Gracias"
        }

        if (sendMsgCall.value === "disabled") {

          const company = await Company.findByPk(companyId);

          await wbot.sendMessage(node.attrs.from, {
            text:
              translatedMessage[company.language],
          });

          const number = node.attrs.from.replace(/\D/g, "");

          const contact = await Contact.findOne({
            where: { companyId, number },
          });

          const ticket = await Ticket.findOne({
            where: {
              contactId: contact.id,
              whatsappId: wbot.id,
              //status: { [Op.or]: ["close"] },
              companyId
            },
          });
          // se não existir o ticket não faz nada.
          if (!ticket) return;

          const date = new Date();
          const hours = date.getHours();
          const minutes = date.getMinutes();

          const body = `Chamada de voz/vídeo perdida às ${hours}:${minutes}`;
          const messageData = {
            id: content.attrs["call-id"],
            ticketId: ticket.id,
            contactId: contact.id,
            body,
            fromMe: false,
            mediaType: "call_log",
            read: true,
            quotedMsgId: null,
            ack: 1,
          };

          await ticket.update({
            lastMessage: body,
          });


          if(ticket.status === "closed") {
            await ticket.update({
              status: "pending",
            });
          }

          return CreateMessageService({ messageData, companyId: companyId });
        }
      }
    });

    wbot.ev.on("contacts.upsert", async (contacts: BContact[]) => {
      // Normalizar contatos para estrutura compatível com Baileys 7.x
      // Em v7, contact.id pode ser LID ou PN
      // contact.phoneNumber ou contact.lid estará presente dependendo do tipo
      const normalizedContacts = contacts.map(contact => {
        // Extrair número de telefone se disponível
        let phoneNumber: string | undefined;
        let lid: string | undefined;
        
        if (contact.phoneNumber) {
          phoneNumber = contact.phoneNumber;
        } else if (contact.lid) {
          lid = contact.lid;
        } else {
          // Fallback: tentar extrair do id se for PN
          const idStr = contact.id?.toString() || "";
          if (!idStr.includes("@lid")) {
            phoneNumber = idStr.replace(/@.*$/, "").replace(/\D/g, "");
          } else {
            lid = idStr;
          }
        }
        
        return {
          id: contact.id,
          phoneNumber,
          lid,
          name: contact.name,
          notify: contact.notify,
          // Preservar outros campos se necessário
        };
      });

      await createOrUpdateBaileysService({
        whatsappId: whatsapp.id,
        contacts: normalizedContacts,
      });
    });

  } catch (err) {
    Sentry.captureException(err);
    logger.error(err);
  }
};

export default wbotMonitor;
