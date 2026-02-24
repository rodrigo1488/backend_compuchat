import { Op } from "sequelize";
import AppError from "../../errors/AppError";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";
import Contact from "../../models/Contact";
import User from "../../models/User";
import Queue from "../../models/Queue";
import ShowTicketService from "../TicketServices/ShowTicketService";
import { AIProviderSelector } from "./AIProviderSelector";

interface AnalyzeChatParams {
  ticketId: number;
  companyId: number;
  question?: string;
  suggestResponse?: boolean;
}

interface AudioSummaryParams {
  ticketId: number;
  companyId: number;
}

interface AnalyzeChatResponse {
  analysis: string;
  suggestions?: string[];
  keyPoints: string[];
}

interface AudioSummaryResponse {
  summary: string;
  audioCount: number;
  transcripts: Array<{
    messageId: string;
    timestamp: string;
    summary: string;
  }>;
}

interface ImproveMessageParams {
  ticketId: number;
  companyId: number;
  draftText?: string;
}

interface ImproveMessageResponse {
  improvedText: string;
  originalText?: string;
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

// Função removida - agora usamos provider.generateText diretamente

// Buscar últimas 20 mensagens do ticket
const fetchLastMessages = async (
  ticketId: number,
  companyId: number
): Promise<any[]> => {
  const messages = await Message.findAll({
    where: {
      ticketId,
      companyId,
      isDeleted: false
    },
    include: [
      "contact"
    ],
    order: [["createdAt", "DESC"]],
    limit: 100,
    raw: false
  });

  return messages.reverse().map((msg: any) => ({
    id: msg.id,
    body: msg.body || "",
    fromMe: msg.fromMe,
    createdAt: formatDateTime(msg.createdAt),
    sender: msg.fromMe ? "ATENDENTE" : "CLIENTE",
    contactName: msg.contact?.name || "Desconhecido",
    mediaType: msg.mediaType,
    mediaUrl: msg.mediaUrl
  }));
};

// Analisar contexto do chat
export const analyzeChatContext = async ({
  ticketId,
  companyId,
  question,
  suggestResponse = false
}: AnalyzeChatParams): Promise<AnalyzeChatResponse> => {
  // Selecionar provider usando configuração automática (usa "chat" como tipo)
  const provider = await AIProviderSelector.getProvider(companyId, "chat");

  const ticket = await ShowTicketService(ticketId, companyId);
  if (!ticket) {
    throw new AppError("ERR_NO_TICKET_FOUND", 404);
  }

  // Buscar informações do ticket
  const ticketData = await Ticket.findByPk(ticketId, {
    include: [
      { model: Contact, attributes: ["id", "name", "number"] },
      { model: User, attributes: ["id", "name"] },
      { model: Queue, attributes: ["id", "name"] }
    ]
  });

  // Buscar últimas 20 mensagens
  const messages = await fetchLastMessages(ticketId, companyId);

  if (messages.length === 0) {
    throw new AppError("ERR_NO_MESSAGES_FOUND", 404);
  }

  // Construir contexto das mensagens
  const messagesContext = messages.map((msg, index) => {
    return `[${msg.createdAt}] ${msg.sender} (${msg.contactName}): ${msg.body || "[Mídia]"}`;
  }).join("\n");

  // Construir prompt
  let systemPrompt = `Você é o Compuchat, um assistente de IA especializado em análise de conversas de atendimento.

CONTEXTO DO TICKET:
- Status: ${ticketData.status}
- Contato: ${ticketData.contact?.name || "Desconhecido"}
- Atendente: ${ticketData.user?.name || "Sem atendente"}
- Fila: ${ticketData.queue?.name || "Sem fila"}
- Criado em: ${formatDateTime(ticketData.createdAt)}
- Última atualização: ${formatDateTime(ticketData.updatedAt)}

ÚLTIMAS ${messages.length} MENSAGENS DA CONVERSA:
${messagesContext}

INSTRUÇÕES:
${suggestResponse
      ? `- Analise o contexto da conversa
- Gere 3-5 sugestões de resposta curtas e objetivas que o atendente pode usar
- As sugestões devem ser profissionais, empáticas e diretas
- Foque em resolver o problema do cliente de forma eficiente`
      : question
        ? `- Responda a seguinte pergunta do usuário sobre a conversa: "${question}"
- Seja objetivo e preciso
- Use apenas as informações fornecidas no contexto`
        : `- Analise o contexto da conversa
- Identifique os pontos principais discutidos
- Resuma a situação atual do atendimento
- Destaque informações importantes que o atendente deve saber
- Seja profissional, empático e prestativo
- Evite linguagem muito robótica`}

FORMATO DE RESPOSTA:
${suggestResponse
      ? `Retorne APENAS um JSON válido com este formato:
{
  "suggestions": ["sugestão 1", "sugestão 2", "sugestão 3"],
  "keyPoints": ["ponto 1", "ponto 2", "ponto 3"]
}`
      : `Retorne APENAS um JSON válido com este formato:
{
  "analysis": "análise detalhada da conversa",
  "keyPoints": ["ponto principal 1", "ponto principal 2", "ponto principal 3"]
}`}`;

  try {
    // Usar o provider selecionado para gerar a análise
    const responseText = await provider.generateText(systemPrompt, {
      temperature: 0.3,
      maxTokens: 4096,
      topP: 0.95
    });

    // Tentar extrair JSON da resposta
    let parsedResponse: any = {};
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedResponse = JSON.parse(jsonMatch[0]);
      } else {
        // Se não encontrar JSON, usar resposta completa como análise
        parsedResponse = {
          analysis: responseText,
          keyPoints: []
        };
      }
    } catch (parseError) {
      parsedResponse = {
        analysis: responseText,
        keyPoints: []
      };
    }

    return {
      analysis: parsedResponse.analysis || responseText,
      suggestions: parsedResponse.suggestions || [],
      keyPoints: parsedResponse.keyPoints || []
    };
  } catch (error: any) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(`Erro ao processar análise do chat: ${error.message || "Erro desconhecido"}`, 500);
  }
};

// Resumir áudios não ouvidos
export const summarizeUnreadAudios = async ({
  ticketId,
  companyId
}: AudioSummaryParams): Promise<AudioSummaryResponse> => {
  // Selecionar provider usando configuração automática (usa "chat" como tipo, mas poderia ter um específico)
  const provider = await AIProviderSelector.getProvider(companyId, "chat");

  const ticket = await ShowTicketService(ticketId, companyId);
  if (!ticket) {
    throw new AppError("ERR_NO_TICKET_FOUND", 404);
  }

  // Buscar mensagens de áudio não ouvidas
  const audioMessages = await Message.findAll({
    where: {
      ticketId,
      companyId,
      read: false,
      mediaType: "audio",
      isDeleted: false
    },
    include: [
      "contact"
    ],
    order: [["createdAt", "ASC"]],
    raw: false
  });

  if (audioMessages.length === 0) {
    return {
      summary: "Nenhum áudio não ouvido encontrado neste ticket.",
      audioCount: 0,
      transcripts: []
    };
  }

  // Construir contexto dos áudios
  const audioContext = audioMessages.map((msg: any, index: number) => {
    const timestamp = formatDateTime(msg.createdAt);
    const sender = msg.fromMe ? "ATENDENTE" : "CLIENTE";
    const contactName = msg.contact?.name || "Desconhecido";

    // Se houver transcrição no body, usar. Caso contrário, indicar que precisa transcrição
    const transcript = msg.body && msg.body.trim()
      ? msg.body
      : "[Áudio sem transcrição disponível]";

    return `ÁUDIO ${index + 1}:
- Data/Hora: ${timestamp}
- Remetente: ${sender} (${contactName})
- Transcrição: ${transcript}`;
  }).join("\n\n");

  const systemPrompt = `Você é o Compuchat, um assistente de IA especializado em resumir conversas de áudio.

CONTEXTO:
Foram recebidos ${audioMessages.length} áudio(s) não ouvido(s) neste ticket de atendimento.

TRANSCRIÇÕES DOS ÁUDIOS:
${audioContext}

INSTRUÇÕES:
- Crie um resumo objetivo e conciso de todos os áudios
- Destaque os pontos principais mencionados em cada áudio
- Organize por ordem cronológica
- Seja claro e direto
- Se algum áudio não tiver transcrição, indique isso no resumo

FORMATO:
Retorne APENAS um JSON válido:
{
  "summary": "resumo completo dos áudios",
  "transcripts": [
    {
      "messageId": "id da mensagem",
      "timestamp": "data/hora",
      "summary": "resumo deste áudio específico"
    }
  ]
}`;

  try {
    // Usar o provider selecionado para gerar o resumo
    const responseText = await provider.generateText(systemPrompt, {
      temperature: 0.3,
      maxTokens: 4096,
      topP: 0.95
    });

    // Tentar extrair JSON da resposta
    let parsedResponse: any = {};
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedResponse = JSON.parse(jsonMatch[0]);
      } else {
        parsedResponse = {
          summary: responseText,
          transcripts: []
        };
      }
    } catch (parseError) {
      parsedResponse = {
        summary: responseText,
        transcripts: []
      };
    }

    // Garantir que temos os IDs corretos nos transcripts
    const transcripts = audioMessages.map((msg: any, index: number) => ({
      messageId: msg.id,
      timestamp: formatDateTime(msg.createdAt),
      summary: parsedResponse.transcripts?.[index]?.summary || `Áudio ${index + 1}`
    }));

    return {
      summary: parsedResponse.summary || responseText,
      audioCount: audioMessages.length,
      transcripts
    };
  } catch (error: any) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(`Erro ao processar resumo de áudios: ${error.message || "Erro desconhecido"}`, 500);
  }
};

// Melhorar texto da mensagem
export const improveMessage = async ({
  ticketId,
  companyId,
  draftText = ""
}: ImproveMessageParams): Promise<ImproveMessageResponse> => {
  // Selecionar provider usando configuração automática
  const provider = await AIProviderSelector.getProvider(companyId, "messageImprovement");

  const ticket = await ShowTicketService(ticketId, companyId);
  if (!ticket) {
    throw new AppError("ERR_NO_TICKET_FOUND", 404);
  }

  // Buscar informações do ticket
  const ticketData = await Ticket.findByPk(ticketId, {
    include: [
      { model: Contact, attributes: ["id", "name", "number"] },
      { model: User, attributes: ["id", "name"] },
      { model: Queue, attributes: ["id", "name"] }
    ]
  });

  if (!ticketData) {
    throw new AppError("ERR_NO_TICKET_FOUND", 404);
  }

  // Buscar últimas 20 mensagens para contexto
  const messages = await fetchLastMessages(ticketId, companyId);

  // Construir contexto das mensagens
  const messagesContext = messages.length > 0
    ? messages.map((msg, index) => {
      return `[${msg.createdAt}] ${msg.sender} (${msg.contactName}): ${msg.body || "[Mídia]"}`;
    }).join("\n")
    : "Nenhuma mensagem anterior na conversa.";

  // Construir prompt baseado se há rascunho ou não
  let systemPrompt = `Você é o Compuchat, um assistente de IA especializado em melhorar mensagens de atendimento ao cliente.

CONTEXTO DO TICKET:
- Status: ${ticketData.status}
- Contato: ${ticketData.contact?.name || "Desconhecido"}
- Atendente: ${ticketData.user?.name || "Sem atendente"}
- Fila: ${ticketData.queue?.name || "Sem fila"}

ÚLTIMAS 20 MENSAGENS DA CONVERSA:
${messagesContext}

${draftText.trim()
      ? `RASCUNHO DA MENSAGEM DO ATENDENTE:
"${draftText}"

INSTRUÇÕES:
- Melhore o rascunho acima considerando o contexto da conversa
- Corrija erros de gramática e ortografia
- Ajuste o tom para ser profissional, empático e adequado ao contexto
- Mantenha a intenção e o significado original
- Se necessário, adicione informações relevantes do contexto da conversa
- Mantenha a mensagem clara, objetiva e apropriada para atendimento ao cliente
- Use o nome do cliente quando apropriado: ${ticketData.contact?.name || "o cliente"}
- Seja respeitoso e prestativo

IMPORTANTE: Retorne APENAS o texto melhorado, sem explicações ou comentários adicionais.`
      : `INSTRUÇÕES:
- Com base no contexto da conversa acima, sugira uma resposta completa e apropriada
- A resposta deve ser profissional, empática e adequada ao contexto
- Considere o status do ticket e o histórico da conversa
- Use o nome do cliente quando apropriado: ${ticketData.contact?.name || "o cliente"}
- Seja respeitoso, prestativo e direto
- A resposta deve ajudar a resolver a situação do cliente de forma eficiente

IMPORTANTE: Retorne APENAS o texto da resposta sugerida, sem explicações ou comentários adicionais.`}`;

  try {
    console.log(`📤 Enviando requisição para ${provider.name} - Melhorar mensagem...`);
    const textResponse = await provider.generateText(systemPrompt, {
      temperature: draftText.trim() ? 0.4 : 0.6,
      maxTokens: 2048
    });

    console.log(`✅ Texto melhorado gerado com sucesso usando ${provider.name} (${textResponse.length} caracteres)`);

    const cleanedText = textResponse
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s*["']|["']\s*$/g, "")
      .trim();

    return {
      improvedText: cleanedText || (draftText.trim() || "Desculpe, não foi possível melhorar a mensagem."),
      originalText: draftText.trim() || undefined
    };
  } catch (err: any) {
    console.error(`❌ Erro ao melhorar mensagem com ${provider.name}:`, {
      message: err.message
    });

    if (err instanceof AppError) {
      throw err;
    }

    throw new AppError(`Erro ao melhorar mensagem: ${err.message || "Erro desconhecido"}`, 500);
  }
};

interface GenerateTicketInfoParams {
  ticketId: number;
  companyId: number;
}

interface GenerateTicketInfoResponse {
  title: string;
  description: string;
  clientName: string;
}

// Gerar informações do ticket para criação em sistema externo
export const generateTicketInfo = async ({
  ticketId,
  companyId
}: GenerateTicketInfoParams): Promise<GenerateTicketInfoResponse> => {
  // Selecionar provider usando configuração automática (usa "messageImprovement" como tipo)
  const provider = await AIProviderSelector.getProvider(companyId, "messageImprovement");

  const ticket = await ShowTicketService(ticketId, companyId);
  if (!ticket) {
    throw new AppError("ERR_NO_TICKET_FOUND", 404);
  }

  // Buscar informações do ticket
  const ticketData = await Ticket.findByPk(ticketId, {
    include: [
      { model: Contact, attributes: ["id", "name", "number"] },
      { model: User, attributes: ["id", "name"] },
      { model: Queue, attributes: ["id", "name"] }
    ]
  });

  if (!ticketData) {
    throw new AppError("ERR_NO_TICKET_FOUND", 404);
  }

  // Buscar últimas 20 mensagens para contexto
  const messages = await fetchLastMessages(ticketId, companyId);

  // Construir contexto das mensagens
  const messagesContext = messages.length > 0
    ? messages.map((msg, index) => {
      return `[${msg.createdAt}] ${msg.sender} (${msg.contactName}): ${msg.body || "[Mídia]"}`;
    }).join("\n")
    : "Nenhuma mensagem anterior na conversa.";

  // Construir prompt para gerar informações do ticket
  const systemPrompt = `Você é o Compuchat, um assistente de IA especializado em criar tickets de atendimento.

CONTEXTO DO TICKET:
- Status: ${ticketData.status}
- Contato: ${ticketData.contact?.name || "Desconhecido"}
- Número do Contato: ${ticketData.contact?.number || "Não informado"}
- Atendente: ${ticketData.user?.name || "Sem atendente"}
- Fila: ${ticketData.queue?.name || "Sem fila"}
- Criado em: ${formatDateTime(ticketData.createdAt)}

ÚLTIMAS 20 MENSAGENS DA CONVERSA:
${messagesContext}

INSTRUÇÕES:
- Analise o contexto da conversa acima
- Gere um TÍTULO curto e objetivo (máximo 100 caracteres) que resuma o problema principal
- Gere uma DESCRIÇÃO detalhada (máximo 500 caracteres) que explique o problema e o contexto
- Use o NOME DO CLIENTE exatamente como aparece no contexto: "${ticketData.contact?.name || "Cliente"}"
- O título deve ser claro e direto
- A descrição deve incluir informações relevantes do contexto da conversa
- Seja objetivo e profissional

IMPORTANTE: Retorne APENAS um JSON válido com este formato exato:
{
  "title": "título do ticket",
  "description": "descrição detalhada do ticket",
  "clientName": "nome do cliente"
}

Não inclua explicações, comentários ou texto adicional. Apenas o JSON.`;

  try {
    console.log(`📤 Enviando requisição para ${provider.name} - Gerar informações do ticket...`);
    const textResponse = await provider.generateText(systemPrompt, {
      temperature: 0.3,
      maxTokens: 1024
    });

    console.log(`✅ Informações do ticket geradas com sucesso usando ${provider.name}`);

    // Extrair JSON da resposta
    let parsedResponse: any = {};
    try {
      const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedResponse = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("JSON não encontrado na resposta");
      }
    } catch (parseError) {
      console.error("Erro ao parsear JSON:", parseError);
      // Fallback: usar informações básicas do ticket
      parsedResponse = {
        title: `Atendimento - ${ticketData.contact?.name || "Cliente"}`,
        description: messagesContext.substring(0, 500) || "Sem descrição disponível",
        clientName: ticketData.contact?.name || "Cliente"
      };
    }

    // Garantir que todos os campos existem
    return {
      title: parsedResponse.title || `Atendimento - ${ticketData.contact?.name || "Cliente"}`,
      description: parsedResponse.description || messagesContext.substring(0, 500) || "Sem descrição disponível",
      clientName: parsedResponse.clientName || ticketData.contact?.name || "Cliente"
    };
  } catch (err: any) {
    console.error(`❌ Erro ao gerar informações do ticket com ${provider.name}:`, {
      message: err.message
    });

    if (err instanceof AppError) {
      throw err;
    }

    // Fallback: retornar informações básicas
    return {
      title: `Atendimento - ${ticketData.contact?.name || "Cliente"}`,
      description: messagesContext.substring(0, 500) || "Sem descrição disponível",
      clientName: ticketData.contact?.name || "Cliente"
    };
  }
};
