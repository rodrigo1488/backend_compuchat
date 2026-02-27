import { Op, fn, col, literal } from "sequelize";
import fs from "fs";
import path from "path";
import AppError from "../../errors/AppError";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";
import Contact from "../../models/Contact";
import Company from "../../models/Company";
import User from "../../models/User";
import Queue from "../../models/Queue";
import Tag from "../../models/Tag";
import Whatsapp from "../../models/Whatsapp";
import HelpArticle from "../../models/HelpArticle";
import { AIProviderSelector } from "./AIProviderSelector";
import { ChatMessage } from "./AIProviderInterface";
import DashboardCommandService from "./DashboardCommandService";

interface ChatGeminiParams {
  companyId: number;
  userId: number;
  message: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  articles?: Array<{ id: number; title: string; content: string; summary?: string; keywords?: string; category?: string }>;
}

interface ChatGeminiResponse {
  response: string;
}

interface DetectedEntities {
  attendantNames: string[];
  contactNames: string[];
  period: "today" | "yesterday" | "week" | "month" | "all";
  matchedUsers: Array<{ id: number; name: string }>;
  matchedContacts: Array<{ id: number; name: string; number: string }>;
}

// Função para formatar data/hora
const formatDateTime = (date: Date | string): string => {
  const d = new Date(date);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
};

// Função para retornar o manual de utilização do sistema
const getSystemManual = (): string => {
  // Retornar versão resumida otimizada para economizar tokens
  return `📚 MANUAL DO SISTEMA COMPUCHAT (Resumo)

PRINCIPAIS FUNCIONALIDADES:
• Tickets: Atendimento WhatsApp, transferências, filas, tags
• Dashboard: Métricas, estatísticas, relatórios
• Automação: Flow Builder, campanhas, mensagens rápidas
• IA: Integração OpenAI/Gemini, análise de conversas
• Gestão: Contatos, usuários, filas, tags, formulários

COMO USAR:
- Tickets: Aceitar, responder, transferir, fechar, classificar com tags
- Dashboard: Visualizar métricas, estatísticas, relatórios
- Configurações: WhatsApp, IA, filas, tags, mensagens rápidas
- Campanhas: Criar, agendar, enviar em massa
- Flow Builder: Criar automações e fluxos

IMPORTANTE: Use este conhecimento para responder perguntas sobre funcionalidades e uso do sistema.`;
};

// Função para detectar entidades na pergunta do usuário
const detectEntitiesInQuestion = async (
  question: string,
  companyId: number
): Promise<DetectedEntities> => {
  const questionLower = question.toLowerCase();

  // Detectar período mencionado
  let period: DetectedEntities["period"] = "week";
  if (questionLower.includes("hoje") || questionLower.includes("agora")) {
    period = "today";
  } else if (questionLower.includes("ontem")) {
    period = "yesterday";
  } else if (questionLower.includes("semana") || questionLower.includes("7 dias")) {
    period = "week";
  } else if (questionLower.includes("mês") || questionLower.includes("mes") || questionLower.includes("30 dias")) {
    period = "month";
  }

  // Buscar todos os usuários da empresa
  const users = await User.findAll({
    where: { companyId },
    attributes: ["id", "name"],
    raw: true
  }) as Array<{ id: number; name: string }>;

  // Buscar contatos mencionados
  const contacts = await Contact.findAll({
    where: { companyId },
    attributes: ["id", "name", "number"],
    raw: true
  }) as Array<{ id: number; name: string; number: string }>;

  // Detectar nomes de atendentes na pergunta
  const matchedUsers: Array<{ id: number; name: string }> = [];
  const attendantNames: string[] = [];

  for (const user of users) {
    const userName = user.name.toLowerCase();
    const nameParts = userName.split(" ");

    // Verificar nome completo ou partes do nome
    if (questionLower.includes(userName)) {
      matchedUsers.push(user);
      attendantNames.push(user.name);
    } else {
      // Verificar primeiro nome ou sobrenome (mínimo 3 caracteres)
      for (const part of nameParts) {
        if (part.length >= 3 && questionLower.includes(part)) {
          matchedUsers.push(user);
          attendantNames.push(user.name);
          break;
        }
      }
    }
  }

  // Detectar nomes de contatos na pergunta
  const matchedContacts: Array<{ id: number; name: string; number: string }> = [];
  const contactNames: string[] = [];

  for (const contact of contacts) {
    if (!contact.name) continue;
    const contactName = contact.name.toLowerCase();
    const nameParts = contactName.split(" ");

    if (questionLower.includes(contactName)) {
      matchedContacts.push(contact);
      contactNames.push(contact.name);
    } else {
      for (const part of nameParts) {
        if (part.length >= 3 && questionLower.includes(part)) {
          matchedContacts.push(contact);
          contactNames.push(contact.name);
          break;
        }
      }
    }
  }

  return {
    attendantNames,
    contactNames,
    period,
    matchedUsers,
    matchedContacts
  };
};

// Função para calcular datas do período
const getPeriodDates = (period: DetectedEntities["period"]): { start: Date; end: Date } => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getTime());

  switch (period) {
    case "today":
      return { start: today, end };
    case "yesterday":
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return { start: yesterday, end: today };
    case "week":
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);
      return { start: weekAgo, end };
    case "month":
      const monthAgo = new Date(today);
      monthAgo.setDate(monthAgo.getDate() - 30);
      return { start: monthAgo, end };
    default:
      const defaultStart = new Date(today);
      defaultStart.setDate(defaultStart.getDate() - 7);
      return { start: defaultStart, end };
  }
};

// Função para buscar tickets com mensagens detalhadas
const fetchTicketsWithMessages = async (
  companyId: number,
  period: DetectedEntities["period"],
  userId?: number,
  contactId?: number,
  limit: number = 100
): Promise<any[]> => {
  const { start, end } = getPeriodDates(period);

  const whereClause: any = {
    companyId,
    [Op.or]: [
      { createdAt: { [Op.gte]: start, [Op.lte]: end } },
      { updatedAt: { [Op.gte]: start, [Op.lte]: end } }
    ]
  };

  if (userId) {
    whereClause.userId = userId;
  }

  if (contactId) {
    whereClause.contactId = contactId;
  }

  const tickets = await Ticket.findAll({
    where: whereClause,
    include: [
      { model: Contact, attributes: ["id", "name", "number"] },
      { model: User, attributes: ["id", "name"] },
      { model: Queue, attributes: ["id", "name"] }
    ],
    order: [["updatedAt", "DESC"]],
    limit
  });

  // Buscar mensagens para cada ticket
  const ticketsWithMessages = await Promise.all(
    tickets.map(async (ticket: any) => {
      const messages = await Message.findAll({
        where: {
          ticketId: ticket.id,
          companyId,
          createdAt: {
            [Op.gte]: start,
            [Op.lte]: end
          }
        },
        order: [["createdAt", "ASC"]],
        limit: 50,
        raw: true
      });

      return {
        id: ticket.id,
        status: ticket.status,
        contact: {
          id: ticket.contact?.id,
          name: ticket.contact?.name || "Desconhecido",
          number: ticket.contact?.number || ""
        },
        attendant: {
          id: ticket.user?.id,
          name: ticket.user?.name || "Sem atendente"
        },
        queue: ticket.queue?.name || "Sem fila",
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        messagesCount: messages.length,
        messages: messages.map((msg: any) => ({
          id: msg.id,
          body: (msg.body || "").slice(0, 500),
          fromMe: msg.fromMe,
          createdAt: msg.createdAt,
          sender: msg.fromMe ? "ATENDENTE" : "CLIENTE"
        }))
      };
    })
  );

  return ticketsWithMessages;
};

// Função para buscar dados específicos de um atendente
const fetchUserSpecificData = async (
  companyId: number,
  userId: number,
  userName: string,
  period: DetectedEntities["period"]
): Promise<string> => {
  const { start, end } = getPeriodDates(period);
  const periodLabel = period === "today" ? "HOJE" :
    period === "yesterday" ? "ONTEM" :
      period === "week" ? "ÚLTIMOS 7 DIAS" : "ÚLTIMOS 30 DIAS";

  // Buscar todos os tickets do atendente no período
  const tickets = await fetchTicketsWithMessages(companyId, period, userId, undefined, 50);

  if (tickets.length === 0) {
    return `\n📋 ATENDIMENTOS DE ${userName.toUpperCase()} (${periodLabel}):\n• Nenhum atendimento encontrado no período.\n`;
  }

  let output = `\n═══════════════════════════════════════════════════════════════════
📋 ATENDIMENTOS DETALHADOS DE ${userName.toUpperCase()} (${periodLabel})
Total de atendimentos: ${tickets.length}
═══════════════════════════════════════════════════════════════════\n`;

  for (const ticket of tickets) {
    output += `\n▶ TICKET #${ticket.id} | Status: ${ticket.status.toUpperCase()}
   Cliente: ${ticket.contact.name} (${ticket.contact.number})
   Fila: ${ticket.queue}
   Criado: ${formatDateTime(ticket.createdAt)}
   Atualizado: ${formatDateTime(ticket.updatedAt)}
   Total de mensagens: ${ticket.messagesCount}\n`;

    if (ticket.messages && ticket.messages.length > 0) {
      output += `   --- CONVERSAS COMPLETAS ---\n`;
      // Mostrar mais mensagens quando é um atendente específico (até 30 mensagens)
      for (const msg of ticket.messages.slice(0, 30)) {
        const sender = msg.fromMe ? "🧑‍💼 ATENDENTE" : "👤 CLIENTE";
        const time = formatDateTime(msg.createdAt);
        const body = (msg.body || "").replace(/\n/g, " ").slice(0, 300);
        if (body.trim()) {
          output += `   [${time}] ${sender}: ${body}\n`;
        }
      }
      if (ticket.messages.length > 30) {
        output += `   ... +${ticket.messages.length - 30} mensagens adicionais\n`;
      }
    }
    output += `   ─────────────────────────────────────\n`;
  }

  return output;
};

// Função para buscar dados completos da empresa
const fetchCompanyData = async (companyId: number, period: DetectedEntities["period"] = "week") => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const { start: periodStart } = getPeriodDates(period);
  const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Dados da empresa
  const company = await Company.findByPk(companyId);

  // Contagens gerais
  const totalTickets = await Ticket.count({ where: { companyId } });
  const totalMessages = await Message.count({ where: { companyId } });
  const totalContacts = await Contact.count({ where: { companyId } });

  // Tickets por status
  const ticketsOpen = await Ticket.count({ where: { companyId, status: "open" } });
  const ticketsPending = await Ticket.count({ where: { companyId, status: "pending" } });
  const ticketsClosed = await Ticket.count({ where: { companyId, status: "closed" } });

  // Tickets hoje
  const ticketsToday = await Ticket.count({
    where: { companyId, createdAt: { [Op.gte]: today } }
  });

  // Tickets últimos 7 dias
  const ticketsWeek = await Ticket.count({
    where: { companyId, createdAt: { [Op.gte]: last7Days } }
  });

  // Mensagens hoje
  const messagesToday = await Message.count({
    where: { companyId, createdAt: { [Op.gte]: today } }
  });

  // Buscar atendentes (usuários)
  const users = await User.findAll({
    where: { companyId },
    attributes: ["id", "name", "email", "profile"],
    raw: true
  });

  // Tickets por atendente (período)
  const ticketsByUser = await Ticket.findAll({
    where: {
      companyId,
      userId: { [Op.ne]: null },
      createdAt: { [Op.gte]: periodStart }
    },
    attributes: [
      "userId",
      [fn("COUNT", col("id")), "total"]
    ],
    group: ["userId"],
    raw: true
  }) as any[];

  // Tickets HOJE por atendente
  const ticketsTodayByUser = await Ticket.findAll({
    where: {
      companyId,
      userId: { [Op.ne]: null },
      createdAt: { [Op.gte]: today }
    },
    attributes: [
      "userId",
      [fn("COUNT", col("id")), "total"]
    ],
    group: ["userId"],
    raw: true
  }) as any[];

  // Mapear tickets por usuário
  const userTicketStats = users.map((user: any) => {
    const periodStat = ticketsByUser.find((s: any) => s.userId === user.id);
    const todayStat = ticketsTodayByUser.find((s: any) => s.userId === user.id);
    return {
      userId: user.id,
      userName: user.name,
      ticketsPeriod: periodStat ? parseInt(periodStat.total, 10) : 0,
      ticketsToday: todayStat ? parseInt(todayStat.total, 10) : 0
    };
  }).sort((a, b) => b.ticketsPeriod - a.ticketsPeriod);

  // Buscar filas
  const queues = await Queue.findAll({
    where: { companyId },
    attributes: ["id", "name", "color"],
    raw: true
  });

  // Tickets por fila
  const ticketsByQueue = await Ticket.findAll({
    where: {
      companyId,
      queueId: { [Op.ne]: null },
      createdAt: { [Op.gte]: periodStart }
    },
    attributes: [
      "queueId",
      [fn("COUNT", col("id")), "total"]
    ],
    group: ["queueId"],
    raw: true
  }) as any[];

  const queueStats = ticketsByQueue.map((stat: any) => {
    const queue = queues.find((q: any) => q.id === stat.queueId);
    return {
      queueId: stat.queueId,
      queueName: queue?.name || "Sem fila",
      ticketsCount: parseInt(stat.total, 10)
    };
  }).sort((a, b) => b.ticketsCount - a.ticketsCount);

  // Buscar tags
  const tags = await Tag.findAll({
    where: { companyId },
    attributes: ["id", "name", "color"],
    raw: true
  });

  // Conexões WhatsApp
  const whatsapps = await Whatsapp.findAll({
    where: { companyId },
    attributes: ["id", "name", "status", "isDefault"],
    raw: true
  });

  // Buscar tickets da semana com detalhes básicos e mensagens
  const weekTickets = await fetchTicketsWithMessages(companyId, "week", undefined, undefined, 100);

  return {
    company: company?.name || "Empresa",
    stats: {
      total: {
        tickets: totalTickets,
        messages: totalMessages,
        contacts: totalContacts
      },
      ticketsByStatus: {
        open: ticketsOpen,
        pending: ticketsPending,
        closed: ticketsClosed
      },
      period: {
        ticketsToday,
        ticketsWeek,
        messagesToday
      }
    },
    users: users.map((u: any) => ({ id: u.id, name: u.name, profile: u.profile })),
    userTicketStats,
    queues: queues.map((q: any) => ({ id: q.id, name: q.name })),
    queueStats,
    tags: tags.map((t: any) => ({ id: t.id, name: t.name })),
    whatsapps: whatsapps.map((w: any) => ({
      id: w.id,
      name: w.name,
      status: w.status,
      isDefault: w.isDefault
    })),
    weekTickets
  };
};

// Função para detectar se a mensagem é um comando de agendamento/tarefa
// Prioridade: agendamento > tarefa > outros
// Detecção mais abrangente para pegar todas as variações
const detectCommandType = (message: string): "appointment" | "task" | "none" => {
  const lower = message.toLowerCase().trim();
  
  // Palavras-chave para agendamento (prioridade alta) - expandido
  const appointmentKeywords = [
    "agende", "agendar", "agendamento", "agendamentos",
    "marcar reunião", "marcar encontro", "marcar consulta", "marcar compromisso", "marcar",
    "criar agendamento", "criar reunião", "criar encontro", "criar compromisso",
    "reunião", "reuniões", "encontro", "encontros",
    "compromisso", "compromissos",
    "horário", "horario", "horários", "horarios",
    "agenda", "agendar para", "marcar para",
    "quero agendar", "preciso agendar", "vou agendar",
    "marcar uma", "agendar uma", "fazer um agendamento",
    "agende uma reunião", "agendar uma reunião", "marcar uma reunião"
  ];
  
  // Palavras-chave para tarefa
  const taskKeywords = [
    "criar tarefa", "criar uma tarefa", "nova tarefa",
    "tarefa", "tarefas",
    "lembre-me", "lembrar", "lembre", "me lembre",
    "lembrar de", "não esquecer", "nao esquecer",
    "criar lembrete", "lembrete"
  ];
  
  // Verificar agendamento primeiro (prioridade) - verificação mais robusta
  const hasAppointmentKeyword = appointmentKeywords.some(keyword => {
    // Verificar se a palavra-chave está na mensagem
    if (lower.includes(keyword)) {
      // Se for uma palavra-chave genérica como "marcar" ou "agendar", verificar contexto
      if (keyword === "marcar" || keyword === "agendar") {
        // Verificar se há contexto de tempo/data após a palavra
        const keywordIndex = lower.indexOf(keyword);
        const afterKeyword = lower.substring(keywordIndex + keyword.length, keywordIndex + keyword.length + 30);
        // Se houver palavras relacionadas a tempo/data, é agendamento
        return afterKeyword.includes("reunião") || 
               afterKeyword.includes("encontro") || 
               afterKeyword.includes("consulta") ||
               afterKeyword.includes("compromisso") ||
               afterKeyword.includes("para") ||
               afterKeyword.includes("às") ||
               afterKeyword.includes("as") ||
               afterKeyword.includes("hoje") ||
               afterKeyword.includes("amanhã") ||
               afterKeyword.includes("amanha") ||
               /\d{1,2}[h:]/.test(afterKeyword) ||
               /\d{1,2}\/\d{1,2}/.test(afterKeyword);
      }
      return true;
    }
    return false;
  });
  
  if (hasAppointmentKeyword) {
    return "appointment";
  }
  
  // Verificar tarefa
  if (taskKeywords.some(keyword => lower.includes(keyword))) {
    return "task";
  }
  
  return "none";
};

// Função para detectar confirmações e buscar comando original no histórico
const detectConfirmationAndGetOriginalCommand = (
  message: string,
  conversationHistory: Array<{ role: string; content: string }>
): string | null => {
  const lower = message.toLowerCase().trim();
  const confirmations = ["sim", "confirmo", "confirmar", "ok", "okay", "pode", "pode ser", "tudo bem", "perfeito", "correto", "está certo", "esta certo"];
  
  if (confirmations.some(conf => lower === conf || lower.startsWith(conf + " "))) {
    // Buscar no histórico a última mensagem do usuário que contém comando de agendamento
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const histMsg = conversationHistory[i];
      if (histMsg.role === "user") {
        const commandType = detectCommandType(histMsg.content);
        if (commandType !== "none") {
          console.log(`✅ Confirmação detectada - Processando comando original: "${histMsg.content}"`);
          return histMsg.content;
        }
      }
    }
  }
  
  return null;
};

const ChatGeminiService = async ({
  companyId,
  userId,
  message,
  conversationHistory = [],
  articles
}: ChatGeminiParams): Promise<ChatGeminiResponse> => {
  console.log(`📨 Mensagem recebida: "${message}"`);
  console.log(`📚 Histórico: ${conversationHistory.length} mensagens`);
  
  // PRIORIDADE 1: Verificar se é uma confirmação e buscar comando original
  const originalCommand = detectConfirmationAndGetOriginalCommand(message, conversationHistory);
  const commandToProcess = originalCommand || message;
  
  console.log(`🔍 Comando a processar: "${commandToProcess}"`);
  
  // PRIORIDADE 2: Verificar se a mensagem (ou comando original) é um comando de agendamento/tarefa ANTES de processar com IA
  const commandType = detectCommandType(commandToProcess);
  
  console.log(`🎯 Tipo de comando detectado: ${commandType}`);
  
  if (commandType !== "none") {
    try {
      console.log(`🔍 Comando detectado: ${commandType} - Processando...`);
      if (originalCommand) {
        console.log(`📝 Usando comando original do histórico: "${originalCommand}"`);
      } else {
        console.log(`📝 Processando comando da mensagem atual: "${message}"`);
      }
      
      const commandResult = await DashboardCommandService({
        companyId,
        userId,
        command: commandToProcess
      });

      console.log(`📋 Resultado do comando:`, {
        success: commandResult.success,
        action: commandResult.action,
        hasTask: !!commandResult.task,
        hasAppointment: !!commandResult.appointment
      });

      // Se o comando foi executado com sucesso, retornar mensagem automática SEM chamar IA
      if (commandResult.success) {
        let responseText = "";
        
        if (commandResult.action === "create_task" && commandResult.task) {
          responseText = `✅ **Tarefa criada com sucesso!**\n\n📋 ${commandResult.task.title}`;
          if (commandResult.task.description) {
            responseText += `\n\n${commandResult.task.description}`;
          }
          if (commandResult.task.dueDate) {
            const dueDate = new Date(commandResult.task.dueDate);
            responseText += `\n\n📅 **Prazo:** ${dueDate.toLocaleString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit"
            })}`;
          }
        } else if (commandResult.action === "create_appointment" && commandResult.appointment) {
          responseText = `✅ **Agendamento concluído!**\n\n📅 ${commandResult.appointment.title}`;
          if (commandResult.appointment.description) {
            responseText += `\n\n${commandResult.appointment.description}`;
          }
          if (commandResult.appointment.startTime) {
            const startTime = new Date(commandResult.appointment.startTime);
            const endTime = commandResult.appointment.endTime 
              ? new Date(commandResult.appointment.endTime)
              : new Date(startTime.getTime() + 60 * 60 * 1000);
            
            // Formatar data e hora de forma mais clara
            const startDateStr = startTime.toLocaleDateString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric"
            });
            const startTimeStr = startTime.toLocaleTimeString("pt-BR", {
              hour: "2-digit",
              minute: "2-digit"
            });
            const endTimeStr = endTime.toLocaleTimeString("pt-BR", {
              hour: "2-digit",
              minute: "2-digit"
            });
            
            responseText += `\n\n🕐 **Horário:** ${startDateStr} das ${startTimeStr} às ${endTimeStr}`;
          }
        } else {
          // Fallback para mensagem genérica de sucesso
          responseText = commandResult.message || "✅ Comando executado com sucesso!";
        }

        console.log(`✅ ${commandResult.action === "create_appointment" ? "Agendamento" : "Tarefa"} criado com sucesso - Retornando mensagem automática`);
        
        // Retornar imediatamente SEM processar com IA
        return {
          response: responseText
        };
      } else {
        // Comando não foi executado - continuar com IA para explicar o problema
        console.log(`⚠️ Comando não executado: ${commandResult.message}`);
        // Continuar com o fluxo normal da IA para que ela possa explicar o problema
      }
    } catch (err: any) {
      console.error("❌ Erro ao processar comando no chat:", err);
      // Em caso de erro, continuar com o fluxo normal da IA para que ela possa informar o erro
    }
  }

  // Selecionar provider usando configuração automática
  const provider = await AIProviderSelector.getProvider(companyId, "chat");

  // Buscar artigos se não foram fornecidos
  let articlesToUse = articles;
  if (!articlesToUse || articlesToUse.length === 0) {
    const allArticles = await HelpArticle.findAll({
      where: {
        isActive: true,
        createdByCompanyId: companyId
      },
      order: [["order", "ASC"], ["createdAt", "DESC"]],
      limit: 100 // Limitar a 100 artigos para não exceder tokens
    });
    articlesToUse = allArticles.map(article => ({
      id: article.id,
      title: article.title,
      content: article.content,
      summary: article.summary,
      keywords: article.keywords,
      category: article.category
    }));
  }

  // Detectar entidades na pergunta do usuário
  const entities = await detectEntitiesInQuestion(message, companyId);
  console.log(`🔍 Entidades detectadas:`, {
    atendentes: entities.attendantNames,
    contatos: entities.contactNames,
    periodo: entities.period
  });

  // Buscar dados completos da empresa
  const companyData = await fetchCompanyData(companyId, entities.period);

  // Preparar dados específicos se detectou atendente ou contato na pergunta
  let specificData = "";

  // Buscar dados específicos dos atendentes mencionados
  for (const user of entities.matchedUsers) {
    specificData += await fetchUserSpecificData(companyId, user.id, user.name, entities.period);
  }

  // Buscar tickets de contatos específicos mencionados
  if (entities.matchedContacts.length > 0) {
    for (const contact of entities.matchedContacts) {
      const contactTickets = await fetchTicketsWithMessages(
        companyId,
        entities.period,
        undefined,
        contact.id,
        20
      );

      if (contactTickets.length > 0) {
        specificData += `\n═══════════════════════════════════════════════════════════════════
📋 ATENDIMENTOS DO CONTATO: ${contact.name} (${contact.number})
Total: ${contactTickets.length} tickets
═══════════════════════════════════════════════════════════════════\n`;

        for (const ticket of contactTickets) {
          specificData += `\n▶ TICKET #${ticket.id} | Status: ${ticket.status.toUpperCase()}
   Atendente: ${ticket.attendant.name}
   Fila: ${ticket.queue}
   Criado: ${formatDateTime(ticket.createdAt)}
   Mensagens: ${ticket.messagesCount}\n`;

          if (ticket.messages && ticket.messages.length > 0) {
            specificData += `   --- CONVERSAS ---\n`;
            // Limitar a 20 mensagens para economizar tokens, mas manter contexto
            for (const msg of ticket.messages.slice(0, 20)) {
              const sender = msg.fromMe ? "ATENDENTE" : "CLIENTE";
              const time = formatDateTime(msg.createdAt);
              const body = (msg.body || "").replace(/\n/g, " ").slice(0, 1000);
              if (body.trim()) {
                specificData += `   [${time}] ${sender}: ${body}\n`;
              }
            }
            if (ticket.messages.length > 20) {
              specificData += `   ... +${ticket.messages.length - 20} mensagens\n`;
            }
          }
        }
      }
    }
  }

  // Gerar lista de tickets da semana para o contexto (aumentado limite)
  const weekTicketsList = companyData.weekTickets.slice(0, 50).map((t: any) =>
    `#${t.id} | ${t.status} | ${t.contact.name} | ${formatDateTime(t.updatedAt)}`
  ).join(' | ');

  // Gerar seção com mensagens dos tickets mais recentes (otimizado para economizar tokens mas manter contexto)
  const recentTicketsWithMessages = companyData.weekTickets
    .filter((t: any) => t.messages && Array.isArray(t.messages) && t.messages.length > 0)
    .slice(0, 20) // Aumentado de 10 para 20 tickets
    .map((ticket: any) => {
      let ticketMessages = `\n▶ TICKET #${ticket.id} | ${ticket.status} | ${ticket.contact?.name || "Desconhecido"}\n`;

      // Limitar a 20 mensagens por ticket (aumentado de 6)
      const messagesToShow = ticket.messages.slice(-20);
      for (const msg of messagesToShow) {
        const sender = msg.fromMe ? "ATENDENTE" : "CLIENTE";
        const time = formatDateTime(msg.createdAt);
        const body = (msg.body || "").replace(/\n/g, " ").slice(0, 500); // Aumentado de 150 para 500
        if (body.trim()) {
          ticketMessages += `   [${time}] ${sender}: ${body}\n`;
        }
      }

      if (ticket.messages.length > 20) {
        ticketMessages += `   ... +${ticket.messages.length - 20} msgs\n`;
      }

      return ticketMessages;
    })
    .join('\n');

  // Carregar manual de utilização do sistema
  const systemManual = getSystemManual();

  // Formatar artigos para incluir no contexto
  let articlesContext = "";
  if (articlesToUse && articlesToUse.length > 0) {
    articlesContext = `\n\n📚 ARTIGOS DE AJUDA DISPONÍVEIS (${articlesToUse.length} artigos):
═══════════════════════════════════════════════════════════════════
${articlesToUse.map((article, index) => {
      const content = article.content || article.summary || "";
      const truncatedContent = content.length > 2000 ? content.substring(0, 2000) + "..." : content;
      return `\n[ARTIGO #${article.id}] ${article.title}${article.category ? ` (Categoria: ${article.category})` : ""}${article.keywords ? `\nPalavras-chave: ${article.keywords}` : ""}${article.summary ? `\nResumo: ${article.summary}` : ""}\nConteúdo: ${truncatedContent}`;
    }).join("\n\n─────────────────────────────────────────────────────────────────────")}
═══════════════════════════════════════════════════════════════════`;
  }

  const systemContext = `Você é um ASSISTENTE DE IA para a empresa "${companyData.company}". Você tem acesso aos dados do sistema de atendimento via WhatsApp. Seu nome é Compuchat.

${systemManual}

📊 ESTATÍSTICAS: Tickets: ${companyData.stats.total.tickets} | Mensagens: ${companyData.stats.total.messages} | Contatos: ${companyData.stats.total.contacts} | Abertos: ${companyData.stats.ticketsByStatus.open} | Pendentes: ${companyData.stats.ticketsByStatus.pending} | Fechados: ${companyData.stats.ticketsByStatus.closed} | Hoje: ${companyData.stats.period.ticketsToday} tickets

👥 ATENDENTES (${companyData.users.length}): ${companyData.userTicketStats.slice(0, 5).map((s: any) => `${s.userName}: ${s.ticketsToday} hoje`).join(' | ') || 'Nenhum'}

📁 FILAS: ${companyData.queueStats.slice(0, 5).map((s: any) => `${s.queueName}: ${s.ticketsCount}`).join(' | ') || 'Nenhuma'}

📋 TICKETS RECENTES (${companyData.weekTickets.length}): ${weekTicketsList || 'Nenhum'}

💬 MENSAGENS RECENTES: ${recentTicketsWithMessages || 'Nenhuma'}

${specificData}${articlesContext}

INSTRUÇÕES IMPORTANTES: 
- Use os dados acima para responder.
- PRIORIZE usar informações dos ARTIGOS DE AJUDA quando a pergunta do usuário estiver relacionada a eles.
- Quando responder com base em um artigo, mencione o título do artigo e cite o conteúdo relevante.
- Seja profissional, porém caloroso, prestativo e natural.
- Evite linguagem robótica ou excessivamente formal.
- Cite dados concretos quando disponíveis.
- Responda em português brasileiro.
- ⚠️ ATENÇÃO: Quando o usuário pedir para AGENDAR, MARCAR REUNIÃO, CRIAR COMPROMISSO ou qualquer tipo de agendamento, você NÃO deve tentar criar manualmente. O sistema processará automaticamente ANTES de você responder. Apenas responda normalmente após o processamento.
- ⚠️ ATENÇÃO: Quando o usuário pedir para CRIAR TAREFA ou LEMBRAR DE ALGO, você NÃO deve tentar criar manualmente. O sistema processará automaticamente ANTES de você responder. Apenas responda normalmente após o processamento.
- Se o usuário perguntar algo que não está nos dados ou artigos, informe educadamente que não encontrou a informação.`;

  try {
    console.log(`📤 Enviando mensagem para ${provider.name}...`);
    console.log(`📊 Contexto: ${companyData.stats.total.tickets} tickets, ${companyData.users.length} usuários`);
    if (entities.matchedUsers.length > 0) {
      console.log(`👤 Atendentes detectados: ${entities.matchedUsers.map(u => u.name).join(", ")}`);
    }

    // Buscar configurações do chat IA
    const { getChatConfig } = await import("./ChatConfigService");
    const chatConfig = await getChatConfig(companyId);

    // Limitar histórico de mensagens conforme configuração
    const limitedHistory = conversationHistory.slice(-chatConfig.maxHistoryMessages);

    // Construir histórico de conversa no formato da interface
    const chatMessages: ChatMessage[] = [];

    // Sempre adicionar contexto do sistema na primeira mensagem
    if (limitedHistory.length === 0) {
      chatMessages.push({
        role: "system",
        content: systemContext
      });
      chatMessages.push({
        role: "assistant",
        content: "Olá! Sou o Compuchat, seu assistente inteligente. Tenho acesso completo aos dados do sistema e ao manual de utilização.\n\nPosso ajudar você com:\n✅ Dúvidas sobre como usar o sistema\n✅ Informações sobre atendimentos e conversas\n✅ Estatísticas e métricas em tempo real\n✅ Explicações sobre funcionalidades\n✅ Orientações sobre tickets, filas, contatos, campanhas e muito mais\n\nO que você gostaria de saber?"
      });
    } else {
      // Adicionar contexto atualizado mesmo com histórico
      chatMessages.push({
        role: "system",
        content: systemContext
      });
      chatMessages.push({
        role: "assistant",
        content: "Dados atualizados. Continuando..."
      });

      // Adicionar histórico de conversa limitado
      for (const hist of limitedHistory) {
        chatMessages.push({
          role: hist.role === "user" ? "user" : "assistant",
          content: hist.content
        });
      }
    }

    // Adicionar mensagem atual do usuário
    chatMessages.push({
      role: "user",
      content: message
    });

    // Usar o provider selecionado para realizar o chat com configurações personalizadas
    const text = await provider.chat(chatMessages, {
      temperature: chatConfig.temperature,
      maxTokens: chatConfig.maxTokens,
      topP: chatConfig.topP
    });

    if (!text || text.trim() === "") {
      throw new AppError("Resposta vazia da IA", 500);
    }

    // Sanitizar resposta final: remover caracteres de controle inválidos e garantir encoding correto
    const sanitizedResponse = text
      .trim()
      .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "") // Remover caracteres de controle exceto \n, \r, \t
      .replace(/\uFFFD/g, "") // Remover caracteres de substituição Unicode
      .replace(/\u0000/g, "") // Remover null bytes
      .normalize("NFC"); // Normalizar Unicode

    if (!sanitizedResponse || sanitizedResponse.trim() === "") {
      throw new AppError("Resposta vazia após sanitização", 500);
    }

    console.log(`✅ Resposta recebida do ${provider.name} (${sanitizedResponse.length} caracteres)`);

    return {
      response: sanitizedResponse.trim()
    };
  } catch (err: any) {
    console.error(`❌ Erro ao chamar ${provider.name} API (Chat):`, {
      message: err.message
    });

    if (err instanceof AppError) {
      throw err;
    }

    throw new AppError(`Erro no chat: ${err.message || "Erro desconhecido"}`, 500);
  }
};

export default ChatGeminiService;

