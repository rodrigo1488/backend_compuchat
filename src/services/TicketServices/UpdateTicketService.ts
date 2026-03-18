import moment from "moment";
import * as Sentry from "@sentry/node";
import CheckContactOpenTickets from "../../helpers/CheckContactOpenTickets";
import SetTicketMessagesAsRead from "../../helpers/SetTicketMessagesAsRead";
import { getIO } from "../../libs/socket";
import Ticket from "../../models/Ticket";
import Setting from "../../models/Setting";
import Queue from "../../models/Queue";
import ShowTicketService from "./ShowTicketService";
import ShowWhatsAppService from "../WhatsappService/ShowWhatsAppService";
import SendWhatsAppMessage from "../WbotServices/SendWhatsAppMessage";
import FindOrCreateATicketTrakingService from "./FindOrCreateATicketTrakingService";
import GetTicketWbot from "../../helpers/GetTicketWbot";
import { verifyMessage, getChatJid } from "../WbotServices/wbotMessageListener";
import ListSettingsServiceOne from "../SettingServices/ListSettingsServiceOne"; //NOVO PLW DESIGN//
import ShowUserService from "../UserServices/ShowUserService"; //NOVO PLW DESIGN//
import { isNil } from "lodash";
import Whatsapp from "../../models/Whatsapp";
import AppError from "../../errors/AppError";
import Company from "../../models/Company";
import { logger } from "../../utils/logger";

interface TicketData {
  status?: string;
  userId?: number | null;
  queueId?: number | null;
  chatbot?: boolean;
  queueOptionId?: number;
  whatsappId?: string;
  useIntegration?: boolean;
  integrationId?: number | null;
  promptId?: number | null;
}

interface Request {
  ticketData: TicketData;
  ticketId: string | number;
  companyId: number;
  actionUserId?: string | null;
}

interface Response {
  ticket: Ticket;
  oldStatus: string;
  oldUserId: number | undefined;
}

const UpdateTicketService = async ({
  ticketData,
  ticketId,
  companyId,
  actionUserId = null
}: Request): Promise<Response> => {

  try {
    const { status } = ticketData;
    let { queueId, userId, whatsappId } = ticketData;
    let chatbot: boolean | null = ticketData.chatbot || false;
    let queueOptionId: number | null = ticketData.queueOptionId || null;
    let promptId: number | null = ticketData.promptId || null;
    let useIntegration: boolean | null = ticketData.useIntegration || false;
    let integrationId: number | null = ticketData.integrationId || null;

    const io = getIO();

    const key = "userRating";
    const setting = await Setting.findOne({
      where: {
        companyId,
        key
      }
    });

    const ticket = await ShowTicketService(ticketId, companyId);
    const ticketTraking = await FindOrCreateATicketTrakingService({
      ticketId,
      companyId,
      whatsappId: ticket.whatsappId
    });

    if (isNil(whatsappId)) {
      if (ticket.whatsappId !== null && ticket.whatsappId !== undefined) {
        whatsappId = ticket.whatsappId.toString();
      } else {
        // Quando a conexão foi encerrada, whatsappId pode ser null
        // Permitimos a atualização do ticket mesmo sem whatsappId
        whatsappId = null;
      }
    }

    await SetTicketMessagesAsRead(ticket);

    const oldStatus = ticket.status;
    const oldUserId = ticket.user?.id;
    const oldQueueId = ticket.queueId;

    if (oldStatus === "closed" || (whatsappId !== null && whatsappId !== undefined && Number(whatsappId) !== ticket.whatsappId)) {
      // let otherTicket = await Ticket.findOne({
      //   where: {
      //     contactId: ticket.contactId,
      //     status: { [Op.or]: ["open", "pending", "group"] },
      //     whatsappId
      //   }
      // });
      // if (otherTicket) {
      //     otherTicket = await ShowTicketService(otherTicket.id, companyId)

      //     await ticket.update({status: "closed"})

      //     io.to(oldStatus).emit(`company-${companyId}-ticket`, {
      //       action: "delete",
      //       ticketId: ticket.id
      //     });

      //     return { ticket: otherTicket, oldStatus, oldUserId }
      // }
      await CheckContactOpenTickets(ticket.contact.id, companyId, whatsappId || undefined);
      chatbot = null;
      queueOptionId = null;
    }

    // Só processar mensagem de avaliação se o status está mudando PARA "closed" (não se já estava fechado)
    if (status !== undefined && ["closed"].indexOf(status) > -1 && oldStatus !== "closed") {
      // Quando a avaliação ainda está pendente, mantemos `finishedAt` como `null`
      // para que o listener do WhatsApp consiga reconhecer e salvar a nota do cliente.
      // Importante: não podemos dar `return` antecipado antes de atualizar o `ticket.status`,
      // senão o ticket continua em "open/pending" e a nota não é processada.
      let ratingPending = false;

      // Só tentar obter configurações do WhatsApp se a conexão ainda existir
      let complationMessage: string | null = null;
      let ratingMessage: string | null = null;
      if (ticket.whatsappId !== null && ticket.whatsappId !== undefined) {
        try {
          const whatsappService = await ShowWhatsAppService(
            ticket.whatsappId,
            companyId
          );
          complationMessage = whatsappService.complationMessage;
          ratingMessage = whatsappService.ratingMessage;
        } catch (err) {
          // Se a conexão foi encerrada, continuar sem mensagens de avaliação
        }
      }

      if (setting?.value === "enabled") {
        const ratingUserId = actionUserId != null ? Number(actionUserId) : null;

        if (ticketTraking.ratingAt == null) {
          // Validar se o ticket foi criado há menos de 3 dias
          const ticketCreatedAt = new Date(ticket.createdAt);
          const now = new Date();
          const daysSinceCreation = Math.floor((now.getTime() - ticketCreatedAt.getTime()) / (1000 * 60 * 60 * 24));
          const isCreatedLessThan3Days = daysSinceCreation < 3;

          // Enviar mensagem de avaliação apenas se o ticket foi criado há menos de 3 dias
          if (isCreatedLessThan3Days) {
            const ratingTxt = ratingMessage || "";
            let bodyRatingMessage = `\u200e${ratingTxt}\n\n`;
            bodyRatingMessage +=
              "Digite de 1 à 3 para qualificar nosso atendimento:\n*1* - _Insatisfeito_\n*2* - _Satisfeito_\n*3* - _Muito Satisfeito_\n\n";
            try {
              await SendWhatsAppMessage({ body: bodyRatingMessage, ticket });
            } catch (msgErr) {
              logger.warn(`UpdateTicketService: Não foi possível enviar mensagem de avaliação para o ticket ${ticketId} (conexão indisponível):`, msgErr);
            }

            await ticketTraking.update({
              ratingAt: moment().toDate(),
              // userId é usado no dashboard para atribuir a nota ao atendente.
              userId: ratingUserId != null ? ratingUserId : undefined as any
            });

            io.to(`company-${ticket.companyId}-open`)
              .to(`queue-${ticket.queueId}-open`)
              .to(ticketId.toString())
              .emit(`company-${ticket.companyId}-ticket`, {
                action: "delete",
                ticketId: ticket.id
              });

            ratingPending = true;
          }
        }
        // O dashboard vincula as métricas ao atendente via `TicketTraking.userId`,
        // então precisamos garantir que esse campo esteja preenchido ao iniciar a coleta da avaliação.
        if (ratingUserId != null && Number.isFinite(ratingUserId)) {
          ticketTraking.userId = ratingUserId;
        }
        ticketTraking.ratingAt = moment().toDate();
        ticketTraking.rated = false;
      }

      if (!ratingPending) {
        if (!isNil(complationMessage) && complationMessage !== "") {
          const body = `\u200e${complationMessage}`;
          try {
            await SendWhatsAppMessage({ body, ticket });
          } catch (msgErr) {
            logger.warn(`UpdateTicketService: Não foi possível enviar mensagem de conclusão para o ticket ${ticketId} (conexão indisponível):`, msgErr);
          }
        }

        await ticket.update({
          promptId: null,
          integrationId: null,
          useIntegration: false,
          typebotStatus: false,
          typebotSessionId: null
        })

        ticketTraking.finishedAt = moment().toDate();
        ticketTraking.whatsappId = ticket.whatsappId;
        ticketTraking.userId = ticket.userId;
      }

      /*    queueId = null;
            userId = null; */
    }

    if (queueId !== undefined && queueId !== null) {
      ticketTraking.queuedAt = moment().toDate();
    }

    const settingsTransfTicket = await ListSettingsServiceOne({ companyId: companyId, key: "sendMsgTransfTicket" });

    if (settingsTransfTicket?.value === "enabled") {
      // Mensagem de transferencia da FILA
      if (oldQueueId !== queueId && oldUserId === userId && !isNil(oldQueueId) && !isNil(queueId)) {

        const {language} = await Company.findByPk(companyId);
        const queue = await Queue.findByPk(queueId);
        const wbot = await GetTicketWbot(ticket);

        // Se for Instagram, não enviar mensagem automática via Baileys
        // Instagram não suporta mensagens automáticas de transferência da mesma forma
        if (!wbot) {
          logger.info(`Ticket ${ticket.id} é Instagram. Pulando mensagem automática de transferência.`);
        } else {
          const translatedMessage = {
            'pt': "*Mensagem automática*:\nVocê foi transferido para o departamento *" + queue?.name + "*\naguarde, já vamos te atender!",
            'en': "*Automatic message*:\nYou have been transferred to the *" + queue?.name + "* department\nplease wait, we'll assist you soon!",
            'es': "*Mensaje automático*:\nHas sido transferido al departamento *" + queue?.name + "*\npor favor espera, ¡te atenderemos pronto!"
          }

          try {
            const queueChangedMessage = await wbot.sendMessage(
              getChatJid(ticket),
              {
                text: translatedMessage[language]
              }
            );
            await verifyMessage(queueChangedMessage, ticket, ticket.contact);
          } catch (msgErr) {
            logger.warn(`UpdateTicketService: Não foi possível enviar mensagem de transferência de fila para o ticket ${ticketId} (conexão indisponível):`, msgErr);
          }
        }
      }
      else
        // Mensagem de transferencia do ATENDENTE
        if (oldUserId !== userId && oldQueueId === queueId && !isNil(oldUserId) && !isNil(userId)) {

          const {language} = await Company.findByPk(companyId);
          const wbot = await GetTicketWbot(ticket);
          const nome = await ShowUserService(ticketData.userId);

          // Se for Instagram, não enviar mensagem automática via Baileys
          if (!wbot) {
            logger.info(`Ticket ${ticket.id} é Instagram. Pulando mensagem automática de transferência.`);
          } else {
            const translatedMessage = {
                'pt': "*Mensagem automática*:\nFoi transferido para o atendente *" + nome.name + "*\naguarde, já vamos te atender!",
                'en': "*Automatic message*:\nYou have been transferred to agent *" + nome.name + "*\nplease wait, we'll assist you soon!",
                'es': "*Mensaje automático*:\nHas sido transferido al agente *" + nome.name + "*\npor favor espera, ¡te atenderemos pronto!"
            }

            try {
              const queueChangedMessage = await wbot.sendMessage(
                getChatJid(ticket),
                {
                  text: translatedMessage[language]
                }
              );
              await verifyMessage(queueChangedMessage, ticket, ticket.contact);
            } catch (msgErr) {
              logger.warn(`UpdateTicketService: Não foi possível enviar mensagem de transferência de atendente para o ticket ${ticketId} (conexão indisponível):`, msgErr);
            }
          }
        }
        else
          // Mensagem de transferencia do ATENDENTE e da FILA
          if (oldUserId !== userId && !isNil(oldUserId) && !isNil(userId) && oldQueueId !== queueId && !isNil(oldQueueId) && !isNil(queueId)) {

            const {language} = await Company.findByPk(companyId);
            const wbot = await GetTicketWbot(ticket);
            const queue = await Queue.findByPk(queueId);
            const nome = await ShowUserService(ticketData.userId);

            // Se for Instagram, não enviar mensagem automática via Baileys
            if (!wbot) {
              logger.info(`Ticket ${ticket.id} é Instagram. Pulando mensagem automática de transferência.`);
            } else {
              const translatedMessage = {
                'pt': "*Mensagem automática*:\nVocê foi transferido para o departamento *" + queue?.name + "* e contará com a presença de *" + nome.name + "*\naguarde, já vamos te atender!",
                'en': "*Automatic message*:\nYou have been transferred to the *" + queue?.name + "* department and will be assisted by *" + nome.name + "*\nplease wait, we'll assist you soon!",
                'es': "*Mensaje automático*:\nHas sido transferido al departamento *" + queue?.name + "* y serás atendido por *" + nome.name + "*\npor favor espera, ¡te atenderemos pronto!"
              }

              try {
                const queueChangedMessage = await wbot.sendMessage(
                  getChatJid(ticket),
                  {
                    text: translatedMessage[language]
                  }
                );
                await verifyMessage(queueChangedMessage, ticket, ticket.contact);
              } catch (msgErr) {
                logger.warn(`UpdateTicketService: Não foi possível enviar mensagem de transferência (atendente+fila) para o ticket ${ticketId} (conexão indisponível):`, msgErr);
              }
            }
          } else
            if (oldUserId !== undefined && isNil(userId) && oldQueueId !== queueId && !isNil(queueId)) {

              const {language} = await Company.findByPk(companyId);
              const queue = await Queue.findByPk(queueId);
              const wbot = await GetTicketWbot(ticket);

              // Se for Instagram, não enviar mensagem automática via Baileys
              if (!wbot) {
                logger.info(`Ticket ${ticket.id} é Instagram. Pulando mensagem automática de transferência.`);
              } else {
                const translatedMessage = {
                  'pt': "*Mensagem automática*:\nVocê foi transferido para o departamento *" + queue?.name + "*\naguarde, já vamos te atender!",
                  'en': "*Automatic message*:\nYou have been transferred to the *" + queue?.name + "* department\nplease wait, we'll assist you soon!",
                  'es': "*Mensaje automático*:\nHas sido transferido al departamento *" + queue?.name + "*\npor favor espera, ¡te atenderemos pronto!"
                }

                try {
                  const queueChangedMessage = await wbot.sendMessage(
                    getChatJid(ticket),
                    {
                      text: translatedMessage[language]
                    }
                  );
                  await verifyMessage(queueChangedMessage, ticket, ticket.contact);
                } catch (msgErr) {
                  logger.warn(`UpdateTicketService: Não foi possível enviar mensagem de transferência de fila para o ticket ${ticketId} (conexão indisponível):`, msgErr);
                }
              }
            }
    }

    await ticket.update({
      status,
      queueId,
      userId,
      whatsappId: whatsappId !== null ? whatsappId : undefined,
      chatbot,
      queueOptionId
    });

    await ticket.reload();

    if (status !== undefined && ["pending"].indexOf(status) > -1) {
      ticketTraking.update({
        whatsappId: whatsappId !== null ? whatsappId : ticket.whatsappId,
        queuedAt: moment().toDate(),
        startedAt: null,
        userId: null
      });
    }

    if (status !== undefined && ["open"].indexOf(status) > -1) {
      ticketTraking.update({
        startedAt: moment().toDate(),
        ratingAt: null,
        rated: false,
        whatsappId: whatsappId !== null ? whatsappId : ticket.whatsappId,
        userId: ticket.userId
      });
    }

    await ticketTraking.save();

    if (ticket.status !== oldStatus || ticket.user?.id !== oldUserId) {

      io.to(`company-${companyId}-${oldStatus}`)
        .to(`queue-${ticket.queueId}-${oldStatus}`)
        .to(`user-${oldUserId}`)
        .emit(`company-${companyId}-ticket`, {
          action: "delete",
          ticketId: ticket.id
        });
    }

    io.to(`company-${companyId}-${ticket.status}`)
      .to(`company-${companyId}-notification`)
      .to(`queue-${ticket.queueId}-${ticket.status}`)
      .to(`queue-${ticket.queueId}-notification`)
      .to(ticketId.toString())
      .to(`user-${ticket?.userId}`)
      .to(`user-${oldUserId}`)
      .emit(`company-${companyId}-ticket`, {
        action: "update",
        ticket
      });

    return { ticket, oldStatus, oldUserId };
  } catch (err) {
    Sentry.captureException(err);
    logger.error("UpdateTicketService error:", err);
    throw err;
  }
};

export default UpdateTicketService;
