import { WAMessage } from "baileys";
import * as Sentry from "@sentry/node";
import AppError from "../../errors/AppError";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";
import WhatsAppService from "../WhatsAppService";
import Whatsapp from "../../models/Whatsapp";
import { logger } from "../../utils/logger";
import { Boom } from "@hapi/boom";

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

    // Validar que a mensagem foi retornada com dados completos
    if (!sentMessage || !sentMessage.key || !sentMessage.key.id) {
      logger.error({
        msg: "SendWhatsAppMessage: Mensagem enviada mas sem key.id retornado",
        ticketId: ticket.id,
        whatsappId: whatsapp.id,
        hasSentMessage: !!sentMessage,
        hasKey: !!sentMessage?.key
      });
      throw new AppError("ERR_SENDING_WAPP_MSG_INCOMPLETE");
    }

    await ticket.update({ lastMessage: formattedBody });
    
    logger.debug({
      msg: "SendWhatsAppMessage: Mensagem enviada com sucesso",
      messageId: sentMessage.key.id,
      ticketId: ticket.id,
      remoteJid: sentMessage.key.remoteJid
    });

    return sentMessage;
  } catch (err) {
    const boomError = err as Boom;
    const statusCode = boomError?.output?.statusCode;
    const boomData = boomError?.data;

    logger.error({
      msg: "SendWhatsAppMessage: Erro ao enviar mensagem",
      ticketId: ticket.id,
      whatsappId: whatsapp.id,
      error: err?.message || err,
      statusCode: statusCode ?? null,
      errorType: err?.name || "unknown",
      boomData: boomData ?? null
    });
    Sentry.captureException(err, {
      tags: {
        service: "SendWhatsAppMessage",
        ticketId: ticket.id,
        whatsappId: whatsapp.id,
        statusCode: statusCode || "unknown"
      }
    });
    throw new AppError("ERR_SENDING_WAPP_MSG");
  }
};

export default SendWhatsAppMessage;
