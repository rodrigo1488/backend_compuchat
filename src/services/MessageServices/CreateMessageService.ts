import { getIO } from "../../libs/socket";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";
import Whatsapp from "../../models/Whatsapp";
import Contact from "../../models/Contact";

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
  await Message.upsert({ ...messageData, companyId });

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

  if (message.ticket.queueId !== null && message.queueId === null) {
    await message.update({ queueId: message.ticket.queueId });
  }

  if (!message) {
    throw new Error("ERR_CREATING_MESSAGE");
  }

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

  return message;
};

export default CreateMessageService;
