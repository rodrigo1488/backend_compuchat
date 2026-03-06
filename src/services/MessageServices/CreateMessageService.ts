import { getIO } from "../../libs/socket";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";
import Whatsapp from "../../models/Whatsapp";
import Contact from "../../models/Contact";
import { logger } from "../../utils/logger";
import * as Sentry from "@sentry/node";

export interface MessageData {
  id: string;
  ticketId: number;
  body: string;
  contactId?: number;
  fromMe?: boolean;
  read?: boolean;
  mediaType?: string;
  mediaUrl?: string;
  ack?: number;
  queueId?: number;
  isInternal?: boolean;
  isForwarded?: boolean;
}
interface Request {
  messageData: MessageData;
  companyId: number;
}

const CreateMessageService = async ({
  messageData,
  companyId
}: Request): Promise<Message> => {
  let retries = 0;
  const maxRetries = 3;
  
  while (retries < maxRetries) {
    try {
      // Verificar se a mensagem já existia para emitir socket apenas em criação nova
      // (evita dupla emissão quando controller e listener ambos gravam o mesmo id)
      const existedBefore = await Message.findByPk(messageData.id, { attributes: ["id"] });

      // Tentar salvar a mensagem no banco
      await Message.upsert({ ...messageData, companyId });

      // Buscar a mensagem salva com todos os relacionamentos
      const message = await Message.findByPk(messageData.id, {
        include: [
          {
            model: Contact,
            as: "contact",
            required: false // LEFT JOIN para incluir mensagens sem contactId (mensagens do bot)
          },
          {
            model: Ticket,
            as: "ticket",
            include: [
              "contact",
              "queue",
              {
                model: Whatsapp,
                as: "whatsapp",
                attributes: ["name"]
              }
            ]
          },
          {
            model: Message,
            as: "quotedMsg",
            required: false,
            include: [{
              model: Contact,
              as: "contact",
              required: false
            }]
          }
        ]
      });

      // Validação crítica: se a mensagem não foi encontrada após upsert, algo está errado
      if (!message) {
        throw new Error(`ERR_CREATING_MESSAGE: Mensagem ${messageData.id} não encontrada após upsert`);
      }

      // Sincronizar queueId se necessário (após confirmar que message existe)
      if (message.ticket?.queueId !== null && message.queueId === null) {
        await message.update({ queueId: message.ticket.queueId });
      }

      // Emitir evento Socket.IO apenas quando a mensagem for nova (não existia antes)
      // Evita duplicata no frontend quando controller e listener ambos chamam verifyMessage
      if (!existedBefore) {
        const io = getIO();
        io.to(message.ticketId.toString())
          .to(`company-${companyId}-${message.ticket.status}`)
          .to(`company-${companyId}-notification`)
          .to(`queue-${message.ticket.queueId}-${message.ticket.status}`)
          .to(`queue-${message.ticket.queueId}-notification`)
          .emit(`company-${companyId}-appMessage`, {
            action: "create",
            message,
            ticket: message.ticket,
            contact: message.ticket.contact
          });
      }

      return message;
    } catch (error: any) {
      retries++;
      const isLastAttempt = retries >= maxRetries;
      
      logger.error({
        msg: `CreateMessageService: Erro ao salvar mensagem (tentativa ${retries}/${maxRetries})`,
        messageId: messageData.id,
        ticketId: messageData.ticketId,
        companyId,
        error: error?.message || error,
        stack: error?.stack
      });
      
      Sentry.captureException(error, {
        tags: {
          service: "CreateMessageService",
          messageId: messageData.id,
          ticketId: messageData.ticketId,
          companyId,
          retry: retries
        }
      });

      if (isLastAttempt) {
        // Na última tentativa, lançar o erro para que o chamador saiba que falhou
        throw new Error(`ERR_CREATING_MESSAGE: Falhou após ${maxRetries} tentativas. Último erro: ${error?.message || error}`);
      }
      
      // Aguardar antes de tentar novamente (backoff exponencial)
      await new Promise(resolve => setTimeout(resolve, Math.min(100 * Math.pow(2, retries - 1), 1000)));
    }
  }
  
  // Nunca deveria chegar aqui, mas TypeScript exige retorno
  throw new Error("ERR_CREATING_MESSAGE: Loop de retry inesperado");
};

export default CreateMessageService;
