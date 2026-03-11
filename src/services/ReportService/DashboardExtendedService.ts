import { QueryTypes, Op, Sequelize } from "sequelize";
import sequelize from "../../database";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";
import Campaign from "../../models/Campaign";
import Whatsapp from "../../models/Whatsapp";
import User from "../../models/User";
import Queue from "../../models/Queue";
import Task from "../../models/Task";
import CheckGeminiTokensService, { GeminiTokenInfo } from "../AiServices/CheckGeminiTokensService";
import CheckOpenAITokensService, { OpenAITokenInfo } from "../AiServices/CheckOpenAITokensService";
import { logger } from "../../utils/logger";

export interface ExtendedDashboardData {
  ticketsToday: number;
  resolutionRate: number;
  activeCampaigns: number;
  messagesSent: number;
  pendingTasks: number;
  onlineConnections: number;
  totalConnections: number;
  onlineUsers: number;
  totalUsers: number;
  ticketsByStatus: { status: string; count: number }[];
  ticketsByQueue: { name: string; count: number; color: string }[];
  ticketsByHour: { hour: string; count: number }[];
  ticketsByDay: { day: string; count: number }[];
  topAttendants: { name: string; count: number }[];
  geminiTokens: GeminiTokenInfo;
  openAITokens: OpenAITokenInfo;
}

export interface ExtendedParams {
  days?: number;
  date_from?: string;
  date_to?: string;
}

const DashboardExtendedService = async (
  companyId: number,
  params: ExtendedParams
): Promise<ExtendedDashboardData> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let dateFrom = today;
  let dateTo = new Date();

  if (params.days) {
    dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - params.days);
  }

  if (params.date_from) {
    dateFrom = new Date(params.date_from);
  }

  if (params.date_to) {
    dateTo = new Date(params.date_to);
    dateTo.setHours(23, 59, 59, 999);
  }

  // Tickets criados hoje
  const ticketsToday = await Ticket.count({
    where: {
      companyId,
      createdAt: {
        [Op.gte]: today
      }
    }
  });

  // Total de tickets criados no período (denominador: "recebidos" no período)
  const ticketsTotal = await Ticket.count({
    where: {
      companyId,
      createdAt: {
        [Op.between]: [+dateFrom, +dateTo]
      }
    }
  });

  // Tickets criados no período que já foram fechados (numerador alinhado ao denominador).
  // Antes: contava-se fechados por updatedAt no período, incluindo tickets antigos —
  // isso permitia taxa > 100%. Agora só contamos resoluções dentro do conjunto recebido no período.
  const ticketsFinished = await Ticket.count({
    where: {
      companyId,
      status: "closed",
      createdAt: {
        [Op.between]: [+dateFrom, +dateTo]
      }
    }
  });

  // Taxa de resolução (sempre ≤ 100% quando ticketsTotal > 0)
  const resolutionRate =
    ticketsTotal > 0
      ? Math.min(100, Math.round((ticketsFinished / ticketsTotal) * 100))
      : 0;

  // Campanhas ativas
  const activeCampaigns = await Campaign.count({
    where: {
      companyId,
      status: "EM_ANDAMENTO"
    }
  });

  // Mensagens enviadas no período
  const messagesSent = await Message.count({
    where: {
      companyId,
      fromMe: true,
      createdAt: {
        [Op.between]: [+dateFrom, +dateTo]
      }
    }
  });

  // Tarefas pendentes
  let pendingTasks = 0;
  try {
    pendingTasks = await Task.count({
      where: {
        companyId,
        status: "pending"
      }
    });
  } catch (e) {
    // Task table may not exist yet
    pendingTasks = 0;
  }

  // Conexões WhatsApp online
  const connections = await Whatsapp.findAll({
    where: { companyId },
    attributes: ["id", "status"]
  });
  const onlineConnections = connections.filter(w => w.status === "CONNECTED").length;
  const totalConnections = connections.length;

  // Usuários online
  const users = await User.findAll({
    where: { companyId },
    attributes: ["id", "online"]
  });
  const onlineUsers = users.filter(u => u.online).length;
  const totalUsers = users.length;

  // Tickets por status
  const ticketsByStatusQuery = await Ticket.findAll({
    where: { companyId },
    attributes: [
      "status",
      [Sequelize.fn("COUNT", Sequelize.col("id")), "count"]
    ],
    group: ["status"],
    raw: true
  }) as any[];

  const ticketsByStatus = ticketsByStatusQuery.map(item => ({
    status: item.status,
    count: parseInt(item.count, 10)
  }));

  // Tickets por fila
  const ticketsByQueueQuery = await sequelize.query(`
    SELECT 
      q.name,
      q.color,
      COUNT(t.id) as count
    FROM "Tickets" t
    LEFT JOIN "Queues" q ON q.id = t."queueId"
    WHERE t."companyId" = :companyId
    AND t.status IN ('open', 'pending')
    GROUP BY q.id, q.name, q.color
    ORDER BY count DESC
    LIMIT 6
  `, {
    replacements: { companyId },
    type: QueryTypes.SELECT
  }) as any[];

  const ticketsByQueue = ticketsByQueueQuery.map(item => ({
    name: item.name || "Sem Fila",
    count: parseInt(item.count, 10),
    color: item.color || "#6B7280"
  }));

  // Tickets por hora (últimas 24h)
  const ticketsByHourQuery = await sequelize.query(`
    SELECT 
      TO_CHAR("createdAt", 'HH24:00') as hour,
      COUNT(*) as count
    FROM "Tickets"
    WHERE "companyId" = :companyId
    AND "createdAt" >= NOW() - INTERVAL '24 hours'
    GROUP BY TO_CHAR("createdAt", 'HH24:00')
    ORDER BY hour
  `, {
    replacements: { companyId },
    type: QueryTypes.SELECT
  }) as any[];

  const ticketsByHour = ticketsByHourQuery.map(item => ({
    hour: item.hour,
    count: parseInt(item.count, 10)
  }));

  // Tickets por dia (últimos 7 dias)
  const ticketsByDayQuery = await sequelize.query(`
    SELECT 
      TO_CHAR("createdAt", 'DD/MM') as day,
      COUNT(*) as count
    FROM "Tickets"
    WHERE "companyId" = :companyId
    AND "createdAt" >= NOW() - INTERVAL '7 days'
    GROUP BY TO_CHAR("createdAt", 'DD/MM'), DATE("createdAt")
    ORDER BY DATE("createdAt")
  `, {
    replacements: { companyId },
    type: QueryTypes.SELECT
  }) as any[];

  const ticketsByDay = ticketsByDayQuery.map(item => ({
    day: item.day,
    count: parseInt(item.count, 10)
  }));

  // Top 5 atendentes
  const topAttendantsQuery = await sequelize.query(`
    SELECT 
      u.name,
      COUNT(t.id) as count
    FROM "Tickets" t
    INNER JOIN "Users" u ON u.id = t."userId"
    WHERE t."companyId" = :companyId
    AND t."createdAt" BETWEEN :dateFrom AND :dateTo
    AND t.status = 'closed'
    GROUP BY u.id, u.name
    ORDER BY count DESC
    LIMIT 5
  `, {
    replacements: { companyId, dateFrom, dateTo },
    type: QueryTypes.SELECT
  }) as any[];

  const topAttendants = topAttendantsQuery.map(item => ({
    name: item.name,
    count: parseInt(item.count, 10)
  }));

  // Verificar tokens/quota do Gemini e OpenAI
  let geminiTokens: GeminiTokenInfo = {
    available: false,
    error: "Não verificado"
  };
  let openAITokens: OpenAITokenInfo = {
    available: false,
    error: "Não verificado"
  };

  try {
    geminiTokens = await CheckGeminiTokensService(companyId);
  } catch (error: any) {
    logger.error(`Erro ao verificar tokens do Gemini no dashboard:`, error);
    geminiTokens = {
      available: false,
      error: error.message || "Erro ao verificar"
    };
  }

  try {
    openAITokens = await CheckOpenAITokensService(companyId);
  } catch (error: any) {
    logger.error(`Erro ao verificar tokens do OpenAI no dashboard:`, error);
    openAITokens = {
      available: false,
      error: error.message || "Erro ao verificar"
    };
  }

  return {
    ticketsToday,
    resolutionRate,
    activeCampaigns,
    messagesSent,
    pendingTasks,
    onlineConnections,
    totalConnections,
    onlineUsers,
    totalUsers,
    ticketsByStatus,
    ticketsByQueue,
    ticketsByHour,
    ticketsByDay,
    topAttendants,
    geminiTokens,
    openAITokens
  };
};

export default DashboardExtendedService;

