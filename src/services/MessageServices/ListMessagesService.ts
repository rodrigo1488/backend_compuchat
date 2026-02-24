import { FindOptions } from "sequelize/types";
import { Op } from "sequelize";
import AppError from "../../errors/AppError";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";
import ShowTicketService from "../TicketServices/ShowTicketService";
import Queue from "../../models/Queue";
import Contact from "../../models/Contact";

interface Request {
  ticketId: string;
  companyId: number;
  pageNumber?: string;
  queues?: number[];
  includeQuoted?: boolean; // Opcional: incluir mensagens citadas
}

interface Response {
  messages: Message[];
  ticket: Ticket;
  count: number;
  hasMore: boolean;
}

const ListMessagesService = async ({
  pageNumber = "1",
  ticketId,
  companyId,
  queues = [],
  includeQuoted = true
}: Request): Promise<Response> => {
  const ticket = await ShowTicketService(ticketId, companyId);

  if (!ticket) {
    throw new AppError("ERR_NO_TICKET_FOUND", 404);
  }

  // await setMessagesAsRead(ticket);
  const limit = 20;
  const offset = limit * (+pageNumber - 1);

  const options: FindOptions = {
    where: {
      ticketId,
      companyId
    }
  };

  if (queues.length > 0) {
    options.where["queueId"] = {
      [Op.or]: {
        [Op.in]: queues,
        [Op.eq]: null
      }
    };
  }

  // Construir includes otimizados
  const includes: any[] = [
    {
      model: Contact,
      as: "contact",
      required: false,
      attributes: ["id", "name", "number", "profilePicUrl"] // Limitar atributos
    }
  ];

  // Incluir quotedMsg apenas se necessário
  if (includeQuoted) {
    includes.push({
      model: Message,
      as: "quotedMsg",
      required: false,
      attributes: ["id", "body", "mediaType", "mediaUrl", "fromMe", "isDeleted", "createdAt"], // Limitar atributos
      include: [{
        model: Contact,
        as: "contact",
        required: false,
        attributes: ["id", "name"] // Limitar atributos
      }]
    });
  }

  // Queue apenas se necessário (geralmente não usado na listagem de mensagens)
  includes.push({
    model: Queue,
    as: "queue",
    required: false,
    attributes: ["id", "name"] // Limitar atributos
  });

  // Para primeira página: buscar mais recentes primeiro, depois reverter
  // Para páginas seguintes: buscar mais antigas primeiro (scroll infinito)
  const isFirstPage = pageNumber === "1";
  
  const { count, rows: messages } = await Message.findAndCountAll({
    ...options,
    limit,
    attributes: {
      exclude: ["dataJson"] // Excluir campo pesado que não é usado na listagem
    },
    include: includes,
    offset,
    order: isFirstPage 
      ? [["createdAt", "DESC"], ["id", "DESC"]] // Primeira página: mais recentes primeiro
      : [["createdAt", "ASC"], ["id", "ASC"]]   // Páginas seguintes: mais antigas primeiro
  });

  const hasMore = count > offset + messages.length;

  // Se é a primeira página, reverter a ordem para mostrar mais antigas primeiro, mais recentes por último
  // Se não, já está na ordem correta (mais antigas primeiro)
  const sortedMessages = isFirstPage ? messages.reverse() : messages;

  return {
    messages: sortedMessages,
    ticket,
    count,
    hasMore
  };
};

export default ListMessagesService;
