import { WAMessage } from "baileys";
import * as Sentry from "@sentry/node";
import AppError from "../../errors/AppError";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";
import WhatsAppService from "../WhatsAppService";
import Whatsapp from "../../models/Whatsapp";

import formatBody from "../../helpers/Mustache";

interface Request {
  body: string;
  ticket: Ticket;
  quotedMsg?: Message;
  mentions?: string[];
}

const SendWhatsAppMessage = async ({
  body,
  ticket,
  quotedMsg,
  mentions
}: Request): Promise<WAMessage | any> => {
  let options: Record<string, any> = {};
  const number = ticket.contact.number;

  // Obter whatsapp do ticket
  const whatsapp = await Whatsapp.findByPk(ticket.whatsappId);
  if (!whatsapp) {
    throw new AppError("ERR_WAPP_NOT_FOUND");
  }

  if (quotedMsg) {
    const chatMessages = await Message.findOne({
      where: {
        id: quotedMsg.id
      }
    });

    if (chatMessages) {
      const msgFound = JSON.parse(chatMessages.dataJson);

      options = {
        quoted: {
          key: msgFound.key,
          message: {
            extendedTextMessage: msgFound.message.extendedTextMessage
          }
        }
      };
    }
  }

  if (mentions && mentions.length > 0 && ticket.isGroup) {
    options.contextInfo = {
      ...(options.contextInfo || {}),
      mentionedJid: mentions
    };
  }

  // Se for Instagram, usa o Adapter
  if (whatsapp.type === "instagram") {
    const { ChannelAdapterFactory } = require("../ChannelAdapters/ChannelAdapterFactory"); // Lazy import to avoid circular dep issues if any, or standard import
    const adapter = ChannelAdapterFactory(whatsapp);
    try {
      const sentMessage = await adapter.sendMessage(whatsapp, ticket.contact, { body });
      await ticket.update({ lastMessage: body });
      return sentMessage;
    } catch (err) {
      Sentry.captureException(err);
      console.log(err);
      throw new AppError("ERR_SENDING_IG_MSG");
    }
  }

  try {
    const formattedBody = formatBody(body, ticket.contact);
    const sentMessage = await WhatsAppService.sendMessage(
      whatsapp,
      number,
      formattedBody,
      options
    );

    await ticket.update({ lastMessage: formattedBody });
    return sentMessage;
  } catch (err) {
    Sentry.captureException(err);
    console.log(err);
    throw new AppError("ERR_SENDING_WAPP_MSG");
  }
};

export default SendWhatsAppMessage;
