import { proto, WASocket } from "baileys";
import {
  convertTextToSpeechAndSaveToFile,
  getBodyMessage,
  getChatJid,
  keepOnlySpecifiedChars,
  transferQueue,
  verifyMediaMessage,
  verifyMessage
} from "../WbotServices/wbotMessageListener";

import fs from "fs";
import path from "path";

import axios from "axios";
import Ticket from "../../models/Ticket";
import Contact from "../../models/Contact";
import Message from "../../models/Message";
import TicketTraking from "../../models/TicketTraking";
import Setting from "../../models/Setting";
import { GEMINI_MODEL, GEMINI_BASE_URL, validateGeminiApiKey, interpretGeminiError } from "../../config/gemini";
import AppError from "../../errors/AppError";
import { logger } from "../../utils/logger";
import CreateMessageService, { MessageData } from "../MessageServices/CreateMessageService";
import generateContextSummary from "../AiServices/GenerateContextSummaryService";
import UpdateTicketService from "../TicketServices/UpdateTicketService";
import GetTicketWbot from "../../helpers/GetTicketWbot";
import Company from "../../models/Company";
import Queue from "../../models/Queue";
import User from "../../models/User";
import ListSettingsServiceOne from "../SettingServices/ListSettingsServiceOne";
import ListQueuesService from "../QueueService/ListQueuesService";
import Tag from "../../models/Tag";
import SyncTags from "../TagServices/SyncTagsService";
import ParseAppointmentCommand from "../AppointmentAIService/ParseAppointmentCommand";

type Session = WASocket & {
  id?: number;
};

// Map para rastrear processamentos em andamento e evitar duplicatas
const processingLocks = new Map<string, number>();

interface IGemini {
  name: string;
  prompt: string;
  voice: string;
  voiceKey: string;
  voiceRegion: string;
  maxTokens: number;
  temperature: number;
  queueId: number;
  maxMessages: number;
  canSendInternalMessages?: boolean;
  canTransferToAgent?: boolean;
  canChangeTag?: boolean;
  permitirCriarAgendamentos?: boolean;
  transferQueueId?: number | null;
}

const sanitizeName = (name: string): string => {
  let sanitized = name.split(" ")[0];
  // Remove apenas caracteres especiais problemáticos, mantendo acentos e letras Unicode
  sanitized = sanitized.replace(/[^\p{L}\p{N}]/gu, "");
  return sanitized.substring(0, 60);
};

/**
 * Envia mensagem automática de transferência para o cliente
 */
const sendTransferMessage = async (
  ticket: Ticket,
  contact: Contact,
  queueId: number | null,
  userId: number | null
): Promise<void> => {
  try {
    // Verificar se a configuração de mensagem automática está habilitada
    const settingsTransfTicket = await ListSettingsServiceOne({
      companyId: ticket.companyId,
      key: "sendMsgTransfTicket"
    });

    if (settingsTransfTicket?.value !== "enabled") {
      logger.info(`Mensagem automática de transferência desabilitada para empresa ${ticket.companyId}`);
      return;
    }

    const company = await Company.findByPk(ticket.companyId);
    const language = company?.language || "pt";
    const wbot = await GetTicketWbot(ticket);

    let translatedMessage: string;

    if (queueId && userId) {
      // Transferência para fila E atendente
      const queue = await Queue.findByPk(queueId);
      const user = await User.findByPk(userId);

      const messages = {
        pt: `*Mensagem automática*:\nVocê foi transferido para o departamento *${queue?.name || "Atendimento"}* e contará com a presença de *${user?.name || "um atendente"}*\naguarde, já vamos te atender!`,
        en: `*Automatic message*:\nYou have been transferred to the *${queue?.name || "Support"}* department and will be assisted by *${user?.name || "an agent"}*\nplease wait, we'll assist you soon!`,
        es: `*Mensaje automático*:\nHas sido transferido al departamento *${queue?.name || "Atención"}* y serás atendido por *${user?.name || "un agente"}*\npor favor espera, ¡te atenderemos pronto!`
      };
      translatedMessage = messages[language as keyof typeof messages] || messages.pt;
    } else if (userId) {
      // Transferência apenas para atendente
      const user = await User.findByPk(userId);

      const messages = {
        pt: `*Mensagem automática*:\nFoi transferido para o atendente *${user?.name || "Atendente"}*\naguarde, já vamos te atender!`,
        en: `*Automatic message*:\nYou have been transferred to agent *${user?.name || "Agent"}*\nplease wait, we'll assist you soon!`,
        es: `*Mensaje automático*:\nHas sido transferido al agente *${user?.name || "Agente"}*\npor favor espera, ¡te atenderemos pronto!`
      };
      translatedMessage = messages[language as keyof typeof messages] || messages.pt;
    } else if (queueId) {
      // Transferência apenas para fila
      const queue = await Queue.findByPk(queueId);

      const messages = {
        pt: `*Mensagem automática*:\nVocê foi transferido para o departamento *${queue?.name || "Atendimento"}*\naguarde, já vamos te atender!`,
        en: `*Automatic message*:\nYou have been transferred to the *${queue?.name || "Support"}* department\nplease wait, we'll assist you soon!`,
        es: `*Mensaje automático*:\nHas sido transferido al departamento *${queue?.name || "Atención"}*\npor favor espera, ¡te atenderemos pronto!`
      };
      translatedMessage = messages[language as keyof typeof messages] || messages.pt;
    } else {
      // Sem informações suficientes
      return;
    }

    // CORREÇÃO: Usar getChatJid para obter o destino correto do chat
    const chatJid = getChatJid(ticket);
    const transferMessage = await wbot.sendMessage(
      chatJid,
      {
        text: translatedMessage
      }
    );
    await verifyMessage(transferMessage!, ticket, contact);
    logger.info(`Mensagem automática de transferência enviada para ticket ${ticket.id}`);
  } catch (error: any) {
    logger.error(`Erro ao enviar mensagem automática de transferência: ${error.message}`);
    // Não lançar erro para não interromper o fluxo de transferência
  }
};

export const handleGemini = async (
  geminiSettings: IGemini,
  msg: proto.IWebMessageInfo,
  wbot: Session,
  ticket: Ticket,
  contact: Contact,
  mediaSent: Message | undefined,
  ticketTraking: TicketTraking
): Promise<void> => {
  // REGRA PARA DESABILITAR O BOT PARA ALGUM CONTATO
  if (contact.disableBot) {
    return;
  }

  const bodyMessage = getBodyMessage(msg);
  if (!bodyMessage) return;

  if (!geminiSettings) return;

  if (msg.messageStubType) return;

  // Lock para evitar processamento duplicado da mesma mensagem
  const messageId = msg.key.id || `${ticket.id}-${Date.now()}`;
  const lockKey = `gemini-${ticket.id}-${messageId}`;
  
  // Verificar se já está processando
  if (processingLocks.has(lockKey)) {
    const lockTime = processingLocks.get(lockKey)!;
    const timeSinceLock = Date.now() - lockTime;
    
    // Se o lock é muito antigo (>30s), pode ser um lock travado, remover
    if (timeSinceLock > 30000) {
      logger.warn(`Lock antigo detectado e removido: ${lockKey} (${timeSinceLock}ms)`);
      processingLocks.delete(lockKey);
    } else {
      logger.warn(`Mensagem já está sendo processada (Gemini), ignorando duplicata: ${lockKey}`);
      return;
    }
  }
  
  // Adicionar lock
  processingLocks.set(lockKey, Date.now());
  
  // Timeout de segurança para remover lock (30 segundos)
  setTimeout(() => {
    if (processingLocks.has(lockKey)) {
      processingLocks.delete(lockKey);
      logger.debug(`Lock removido automaticamente (timeout): ${lockKey}`);
    }
  }, 30000);

  // Buscar API key do Gemini das Settings da empresa
  const geminiSetting = await Setting.findOne({
    where: {
      key: "geminiApiKey",
      companyId: ticket.companyId
    }
  });

  let apiKey: string;
  try {
    apiKey = validateGeminiApiKey(geminiSetting?.value);
  } catch (err: any) {
    logger.error(`Erro ao validar API key do Gemini para empresa ${ticket.companyId}: ${err.message}`);
    return;
  }

  const publicFolder: string = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "public",
    `company${ticket.companyId}`
  );

  // Limitar histórico para não consumir todos os tokens
  // Pegar apenas as últimas mensagens relevantes (máximo 10 para economizar tokens)
  const maxHistoryMessages = Math.min(geminiSettings.maxMessages, 10);
  
  const messages = await Message.findAll({
    where: { ticketId: ticket.id },
    order: [["createdAt", "DESC"]],
    limit: maxHistoryMessages
  });

  // Buscar filas disponíveis para permitir que a IA escolha
  const availableQueues = await ListQueuesService({ companyId: ticket.companyId });
  const queuesList = availableQueues.map(q => `- ${q.name} (ID: ${q.id})`).join('\n');
  const queuesNames = availableQueues.map(q => q.name).join(', ');

  // Buscar tags disponíveis se canChangeTag estiver habilitado
  let tagsList = '';
  let availableTags: Tag[] = [];
  if (geminiSettings.canChangeTag) {
    availableTags = await Tag.findAll({ where: { companyId: ticket.companyId } });
    tagsList = availableTags.map(t => `- ${t.name} (ID: ${t.id})`).join('\n');
  }

  // Prompt do sistema otimizado e mais curto
  const contactName = sanitizeName(contact.name || "Amigo(a)");
  let promptSystem = `Você é um assistente de atendimento. O nome do CLIENTE que você está atendendo é: ${contactName}. Use este nome ao se dirigir ao cliente nas suas respostas.\n${geminiSettings.prompt}\n\nFILAS DISPONÍVEIS PARA TRANSFERÊNCIA:\n${queuesList}\n\nIMPORTANTE: Seja direto e objetivo. Para transferir, use o formato: 'Ação: Transferir para o setor de atendimento [Fila: Nome da Fila]' ou apenas 'Ação: Transferir para o setor de atendimento' para usar a fila padrão.`;

  // Adicionar instruções sobre tags se habilitado
  if (geminiSettings.canChangeTag && tagsList) {
    promptSystem += `\n\nTAGS DISPONÍVEIS PARA ALTERAÇÃO:\n${tagsList}\n\nPara alterar a tag/estágio do ticket, use o formato: 'Ação: Alterar tag [Tag: Nome da Tag]'`;
  }
  
  // Adicionar instruções sobre mensagens internas se habilitado
  if (geminiSettings.canSendInternalMessages) {
    promptSystem += `\n\nANOTAÇÕES INTERNAS: Use [INTERNA]texto[/INTERNA] ANTES ou DEPOIS da resposta ao cliente. Sempre forneça resposta ao cliente.`;
  }

  // Adicionar instruções sobre agendamentos se habilitado
  if (geminiSettings.permitirCriarAgendamentos) {
    promptSystem += `\n\nAGENDAMENTOS: Use [AGENDAR]{"action":"criar|verificar|listar","profissional":"Nome","data":"YYYY-MM-DD","horarioInicio":"HH:mm","horarioFim":"HH:mm"(opcional),"titulo":"Título","descricao":"Desc"(opcional)}[/AGENDAR]. Execute comandos IMEDIATAMENTE sem dizer "vou verificar". Verifique disponibilidade antes de criar. Remova tags [AGENDAR] da resposta final.`;
  }

  if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
    // Construir histórico de conversa no formato Gemini
    const contents: any[] = [];

    // Adicionar prompt do sistema de forma mais eficiente
    // Não adicionar resposta do modelo para economizar tokens
    contents.push({
      role: "user",
      parts: [{ text: promptSystem }]
    });

    // Adicionar histórico de mensagens (inverter ordem para ter do mais antigo ao mais recente)
    const sortedMessages = [...messages].reverse();
    const totalMessages = Math.min(geminiSettings.maxMessages, sortedMessages.length);
    
    // Se há mais de 10 mensagens, resumir as antigas e manter apenas as últimas 6-8 completas
    if (totalMessages > 10) {
      const keepRecent = 7; // Manter últimas 7 mensagens completas
      const oldMessages = sortedMessages.slice(0, totalMessages - keepRecent);
      const recentMessages = sortedMessages.slice(totalMessages - keepRecent);
      
      // Criar resumo simples das mensagens antigas (sem usar IA para economizar tokens)
      const oldMessagesText = oldMessages
        .filter(m => m.mediaType === "conversation" || m.mediaType === "extendedTextMessage")
        .map(m => {
          const sender = m.fromMe ? "Atendente" : "Cliente";
          const body = (m.body || "").substring(0, 100); // Limitar a 100 caracteres por mensagem
          return `${sender}: ${body}`;
        })
        .join(" | ");
      
      if (oldMessagesText) {
        // Adicionar resumo das mensagens antigas
        contents.push({
          role: "user",
          parts: [{ text: `[Resumo do contexto anterior: ${oldMessagesText}]` }]
        });
      }
      
      // Adicionar mensagens recentes completas
      for (const message of recentMessages) {
        if (
          message.mediaType === "conversation" ||
          message.mediaType === "extendedTextMessage"
        ) {
          if (message.fromMe) {
            contents.push({
              role: "model",
              parts: [{ text: message.body }]
            });
          } else {
            contents.push({
              role: "user",
              parts: [{ text: message.body }]
            });
          }
        }
      }
    } else {
      // Se há 10 ou menos mensagens, adicionar todas completas
      for (let i = 0; i < totalMessages; i++) {
        const message = sortedMessages[i];
        if (
          message.mediaType === "conversation" ||
          message.mediaType === "extendedTextMessage"
        ) {
          if (message.fromMe) {
            contents.push({
              role: "model",
              parts: [{ text: message.body }]
            });
          } else {
            contents.push({
              role: "user",
              parts: [{ text: message.body }]
            });
          }
        }
      }
    }

    // Adicionar mensagem atual do usuário
    contents.push({
      role: "user",
      parts: [{ text: bodyMessage! }]
    });

    // Calcular tamanho aproximado do prompt (1 token ≈ 4 caracteres)
    const totalChars = contents.reduce((sum, c) => sum + (c.parts?.[0]?.text?.length || 0), 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    const maxTokens = 30000; // Limite conservador para Gemini
    
    // Se exceder limite, truncar mensagens antigas
    if (estimatedTokens > maxTokens) {
      logger.warn(`⚠️ Prompt muito grande (${estimatedTokens} tokens estimados). Aplicando truncamento...`);
      const charsToRemove = (estimatedTokens - maxTokens) * 4;
      let removed = 0;
      
      // Truncar mensagens antigas (exceto prompt do sistema e mensagem atual)
      for (let i = 1; i < contents.length - 1 && removed < charsToRemove; i++) {
        const text = contents[i].parts?.[0]?.text || "";
        if (text.length > 50) {
          const truncateBy = Math.min(text.length - 50, charsToRemove - removed);
          contents[i].parts[0].text = text.slice(0, text.length - truncateBy) + "...";
          removed += truncateBy;
        }
      }
    }

    try {
      const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent`;

      const { data } = await axios.post(
        `${url}?key=${apiKey}`,
        {
          contents: contents,
          generationConfig: {
            temperature: geminiSettings.temperature,
            topK: 40,
            topP: 0.95,
            // Garantir que há tokens suficientes para a resposta
            // Se maxTokens for muito baixo (menor que 500), usar no mínimo 1024 para garantir resposta
            maxOutputTokens: Math.max(geminiSettings.maxTokens, 1024)
          },
          safetySettings: [
            {
              category: "HARM_CATEGORY_HARASSMENT",
              threshold: "BLOCK_ONLY_HIGH"
            },
            {
              category: "HARM_CATEGORY_HATE_SPEECH",
              threshold: "BLOCK_ONLY_HIGH"
            },
            {
              category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              threshold: "BLOCK_ONLY_HIGH"
            },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_ONLY_HIGH"
            }
          ]
        },
        {
          timeout: 60000
        }
      );

      const candidates = data?.candidates || [];
      
      if (candidates.length === 0) {
        logger.error("Nenhum candidato retornado pelo Gemini");
        logger.error("Resposta completa da API:", JSON.stringify(data, null, 2));
        return;
      }

      const first = candidates[0];
      
      // Verificar finishReason
      if (first?.finishReason && first.finishReason !== "STOP") {
        logger.warn(`⚠️ finishReason: ${first.finishReason}`);
        
        if (first.finishReason === "SAFETY") {
          logger.error("Conteúdo bloqueado pelos filtros de segurança");
          return;
        }
        
        if (first.finishReason === "MAX_TOKENS") {
          logger.warn("⚠️ MAX_TOKENS atingido, resposta pode estar incompleta");
          // Continua para tentar extrair o que foi gerado
        }
        
        if (first.finishReason === "RECITATION") {
          logger.warn("⚠️ RECITATION detectado, resposta pode estar vazia");
        }
      }

      const parts = first?.content?.parts || [];
      let response = parts.map((p: any) => p.text || "").filter((t: string) => t.trim() !== "").join("\n");

      if (!response || response.trim() === "") {
        logger.error("Resposta vazia do Gemini");
        logger.error("Candidato completo:", JSON.stringify(first, null, 2));
        logger.error("Parts:", JSON.stringify(parts, null, 2));
        logger.error("FinishReason:", first?.finishReason);
        logger.error("Resposta completa da API:", JSON.stringify(data, null, 2));
        return;
      }

      logger.info(`✅ Resposta recebida do Gemini (${response.length} caracteres)`);

      // Detectar e processar mensagens internas
      const internalMessages: string[] = [];
      let cleanedResponse = response;

      if (geminiSettings.canSendInternalMessages) {
        // Regex unificado que captura [INTERNA]...[/INTERNA] de forma não-gulosa
        // Usa uma única passagem para evitar duplicação
        const internalMessageRegex = /\[INTERNA\](.*?)\[\/INTERNA\]/gs;
        const processedMatches = new Set<string>(); // Para evitar duplicação
        
        let match;
        // Processar todas as mensagens internas com fechamento explícito
        while ((match = internalMessageRegex.exec(response)) !== null) {
          const fullMatch = match[0]; // [INTERNA]...[/INTERNA]
          const internalContent = match[1].trim();
          
          // Evitar processar a mesma mensagem duas vezes
          if (internalContent && !processedMatches.has(fullMatch)) {
            processedMatches.add(fullMatch);
            internalMessages.push(internalContent);
            // Remover o marcador completo da resposta
            cleanedResponse = cleanedResponse.replace(fullMatch, "").trim();
          }
        }

        // Limpar qualquer [INTERNA] restante sem fechamento (caso a IA tenha esquecido de fechar)
        // Isso garante que nenhum marcador [INTERNA] seja enviado ao cliente
        const openInternalRegex = /\[INTERNA\][^\[]*?(?=\[INTERNA\]|$)/gs;
        while ((match = openInternalRegex.exec(cleanedResponse)) !== null) {
          const fullMatch = match[0];
          const internalContent = match[0].replace(/\[INTERNA\]/g, "").trim();
          
          // Só processar se não foi já processado e não contém [/INTERNA]
          if (internalContent && !fullMatch.includes("[/INTERNA]") && !processedMatches.has(fullMatch)) {
            processedMatches.add(fullMatch);
            internalMessages.push(internalContent);
            cleanedResponse = cleanedResponse.replace(fullMatch, "").trim();
          }
        }

        // Limpeza final: remover qualquer ocorrência restante de [INTERNA] ou [/INTERNA]
        cleanedResponse = cleanedResponse
          .replace(/\[INTERNA\][^\[]*?/g, "") // Remove qualquer [INTERNA] restante
          .replace(/\[\/INTERNA\]/g, "") // Remove qualquer [/INTERNA] solto
          .replace(/\n\s*\n\s*\n/g, "\n\n") // Limpa quebras de linha múltiplas
          .trim();

        // Enviar mensagens internas (apenas uma vez cada)
        const uniqueInternalMessages = [...new Set(internalMessages)]; // Garantir unicidade
        for (const internalContent of uniqueInternalMessages) {
          if (internalContent.trim()) {
            try {
              const messageData: MessageData = {
                id: `${ticket.id}-${Date.now()}-${Math.random()}`,
                body: internalContent.trim(),
                ticketId: ticket.id,
                contactId: ticket.contactId,
                fromMe: true,
                read: true,
                isInternal: true,
                mediaType: "conversation"
              };
              await CreateMessageService({ messageData, companyId: ticket.companyId });
              logger.info(`✅ Mensagem interna enviada: ${internalContent.substring(0, 50)}...`);
            } catch (err: any) {
              logger.error(`❌ Erro ao enviar mensagem interna: ${err.message}`);
            }
          }
        }
        
        // Log para debug
        if (internalMessages.length > 0) {
          logger.info(`📝 Processadas ${uniqueInternalMessages.length} mensagem(ns) interna(s). Resposta limpa: ${cleanedResponse.substring(0, 100)}...`);
        }
      }

      // Processar comandos de agendamento se habilitado
      if (geminiSettings.permitirCriarAgendamentos && response) {
        const appointmentCommandRegex = /\[AGENDAR\](.*?)\[\/AGENDAR\]/gs;
        const appointmentCommands: string[] = [];
        let match;

        while ((match = appointmentCommandRegex.exec(response)) !== null) {
          const commandContent = match[1].trim();
          if (commandContent) {
            appointmentCommands.push(commandContent);
          }
        }

        if (appointmentCommands.length > 0) {
          // Remover frases que indicam que vai verificar depois (já que vamos executar agora)
          const phrasesToRemove = [
            /vou verificar[^.]*/gi,
            /vou checar[^.]*/gi,
            /um momento[^.]*/gi,
            /aguarde[^.]*/gi,
            /por favor[^.]*/gi,
            /desculpe pela (demora|confusão)[^.]*/gi,
            /desculpe[^.]*/gi
          ];
          
          for (const phraseRegex of phrasesToRemove) {
            cleanedResponse = cleanedResponse.replace(phraseRegex, "").trim();
          }
          
          // Processar todos os comandos
          for (const command of appointmentCommands) {
            try {
              const result = await ParseAppointmentCommand({
                command: `[AGENDAR]${command}[/AGENDAR]`,
                companyId: ticket.companyId,
                contactId: contact.id,
                ticketId: ticket.id,
                allowCreate: geminiSettings.permitirCriarAgendamentos || false
              });

              if (result.success) {
                // Adicionar mensagem de sucesso à resposta
                if (result.message) {
                  cleanedResponse = cleanedResponse.replace(
                    /\[AGENDAR\].*?\[\/AGENDAR\]/gs,
                    result.message
                  );
                }
                logger.info(`✅ Comando de agendamento processado: ${result.message}`);
              } else {
                // Adicionar mensagem de erro à resposta
                const errorMsg = result.message || result.error || "Erro ao processar agendamento";
                cleanedResponse = cleanedResponse.replace(
                  /\[AGENDAR\].*?\[\/AGENDAR\]/gs,
                  errorMsg
                );
                logger.error(`❌ Erro ao processar comando de agendamento: ${result.error}`);
              }
            } catch (err: any) {
              logger.error(`❌ Erro ao processar comando de agendamento: ${err.message}`);
              cleanedResponse = cleanedResponse.replace(
                /\[AGENDAR\].*?\[\/AGENDAR\]/gs,
                "Erro ao processar comando de agendamento. Tente novamente."
              );
            }
          }
          
          // Limpar múltiplas quebras de linha e espaços extras
          cleanedResponse = cleanedResponse
            .replace(/\n\s*\n\s*\n/g, "\n\n")
            .replace(/^\s+|\s+$/g, "")
            .trim();
        }
      }

      // Verificar se precisa alterar tag
      if (geminiSettings.canChangeTag && response.includes("Ação: Alterar tag")) {
        // Tentar extrair o nome da tag especificada pela IA
        const tagMatch = response.match(/\[Tag:\s*([^\]]+)\]/i);
        if (tagMatch && tagMatch[1]) {
          const specifiedTagName = tagMatch[1].trim();
          
          // Buscar tag pelo nome (case-insensitive)
          const matchedTag = availableTags.find(
            t => t.name.toLowerCase() === specifiedTagName.toLowerCase()
          );
          
          if (matchedTag) {
            try {
              // Sincronizar tag do ticket
              await SyncTags({ tags: [matchedTag], ticketId: ticket.id });
              logger.info(`Tag alterada para "${matchedTag.name}" no ticket ${ticket.id}`);
            } catch (err: any) {
              logger.error(`Erro ao alterar tag: ${err.message}`);
            }
          } else {
            logger.warn(`Tag especificada pela IA não encontrada: "${specifiedTagName}"`);
          }
        }

        // Remover ação de alteração de tag da resposta
        cleanedResponse = cleanedResponse
          .replace(/Ação: Alterar tag\s*\[Tag:[^\]]+\]/gi, "")
          .replace("Ação: Alterar tag", "")
          .trim();
      }

      // Verificar se precisa transferir para fila
      if (response.includes("Ação: Transferir para o setor de atendimento")) {
        // Se canTransferToAgent não estiver habilitado, apenas enviar mensagem
        if (!geminiSettings.canTransferToAgent) {
          const company = await Company.findByPk(ticket.companyId);
          const language = company?.language || "pt";
          const wbot = await GetTicketWbot(ticket);
          
          const waitMessage = {
            pt: "Aguarde que algum de nossos atendentes já irá lhe atender.",
            en: "Please wait, one of our attendants will assist you shortly.",
            es: "Por favor espere, uno de nuestros atendentes le atenderá en breve."
          };
          
          const messageText = waitMessage[language as keyof typeof waitMessage] || waitMessage.pt;
          const sentMessage = await wbot.sendMessage(msg.key.remoteJid!, {
            text: messageText
          });
          await verifyMessage(sentMessage!, ticket, contact);
          
          cleanedResponse = cleanedResponse
            .replace(/Ação: Transferir para o setor de atendimento\s*\[Fila:[^\]]+\]/gi, "")
            .replace("Ação: Transferir para o setor de atendimento", "")
            .trim();
        } else {
        let targetQueueId: number | null = null;
        let targetQueueName: string | null = null;

        // Tentar extrair o nome da fila especificada pela IA
        const queueMatch = response.match(/\[Fila:\s*([^\]]+)\]/i);
        if (queueMatch && queueMatch[1]) {
          const specifiedQueueName = queueMatch[1].trim();
          
          // Buscar fila pelo nome (case-insensitive)
          const matchedQueue = availableQueues.find(
            q => q.name.toLowerCase() === specifiedQueueName.toLowerCase()
          );
          
          if (matchedQueue) {
            targetQueueId = matchedQueue.id;
            targetQueueName = matchedQueue.name;
            logger.info(`IA especificou fila: "${specifiedQueueName}" -> ID: ${targetQueueId}`);
          } else {
            logger.warn(`Fila especificada pela IA não encontrada: "${specifiedQueueName}". Usando fila padrão.`);
          }
        }

        // Se não encontrou fila especificada, usar a fila padrão configurada
        if (!targetQueueId) {
          targetQueueId = geminiSettings.transferQueueId || geminiSettings.queueId;
          const defaultQueue = availableQueues.find(q => q.id === targetQueueId);
          targetQueueName = defaultQueue?.name || "Atendimento";
          logger.info(`Usando fila padrão configurada: ID ${targetQueueId}`);
        }

        if (targetQueueId) {
          try {
            // Gerar resumo do contexto antes de transferir
            const summary = await generateContextSummary({
              ticketId: ticket.id,
              companyId: ticket.companyId,
              provider: "gemini",
              maxMessages: geminiSettings.maxMessages
            });

            // Enviar resumo como mensagem interna
            const summaryMessageData: MessageData = {
              id: `${ticket.id}-${Date.now()}-summary`,
              body: `📋 RESUMO DO CONTEXTO (antes da transferência):\n\n${summary}`,
              ticketId: ticket.id,
              contactId: ticket.contactId,
              fromMe: true,
              read: true,
              isInternal: true,
              mediaType: "conversation"
            };
            await CreateMessageService({ messageData: summaryMessageData, companyId: ticket.companyId });
            logger.info(`Resumo do contexto gerado antes da transferência do ticket ${ticket.id}`);
          } catch (err: any) {
            logger.error(`Erro ao gerar resumo antes da transferência: ${err.message}`);
            // Continua com a transferência mesmo se o resumo falhar
          }

          // Transferir para a fila
          await transferQueue(targetQueueId, ticket, contact);
          logger.info(`Ticket ${ticket.id} transferido para fila ${targetQueueId} (${targetQueueName})`);
          
          // NOTA: UpdateTicketService já envia a mensagem automática de transferência, não precisa chamar sendTransferMessage novamente
        } else {
          logger.error(`Nenhuma fila disponível para transferência do ticket ${ticket.id}`);
        }

        // Remover ação e especificação de fila da resposta
        cleanedResponse = cleanedResponse
          .replace(/Ação: Transferir para o setor de atendimento\s*\[Fila:[^\]]+\]/gi, "")
          .replace("Ação: Transferir para o setor de atendimento", "")
          .trim();
      }
    }

      // Validação final: garantir que nenhum marcador [INTERNA] seja enviado ao cliente
      if (cleanedResponse.includes("[INTERNA]") || cleanedResponse.includes("[/INTERNA]")) {
        logger.error(`⚠️ ATENÇÃO: Marcadores [INTERNA] ainda presentes na resposta! Removendo...`);
        cleanedResponse = cleanedResponse
          .replace(/\[INTERNA\][^\[]*?/g, "")
          .replace(/\[\/INTERNA\]/g, "")
          .trim();
      }

      // Enviar resposta (sem mensagens internas)
      // Se a resposta limpa estiver vazia mas havia mensagens internas, enviar mensagem padrão
      if (!cleanedResponse.trim() && internalMessages.length > 0) {
        logger.warn(`Resposta limpa vazia após remover mensagens internas. Enviando mensagem padrão.`);
        cleanedResponse = "Entendi sua solicitação. Estou verificando e em breve retorno com mais informações.";
      }

      if (cleanedResponse.trim()) {
        // Verificar se mensagem duplicada antes de enviar
        const recentMessage = await Message.findOne({
          where: {
            ticketId: ticket.id,
            fromMe: true
          },
          order: [["createdAt", "DESC"]]
        });

        if (recentMessage) {
          const timeDiff = Date.now() - new Date(recentMessage.createdAt).getTime();
          const isRecent = timeDiff < 30000; // 30 segundos
          const normalizedRecent = recentMessage.body?.trim().toLowerCase().replace(/\u200e/g, "").trim() || "";
          const normalizedResponse = cleanedResponse.trim().toLowerCase().replace(/\u200e/g, "").trim();
          const isIdentical = normalizedRecent === normalizedResponse;
          
          if (isRecent && isIdentical) {
            logger.warn(`Mensagem duplicada detectada (Gemini), não enviando. Ticket: ${ticket.id}, TimeDiff: ${timeDiff}ms, Conteúdo: ${normalizedResponse.substring(0, 50)}...`);
            // Remover lock antes de retornar
            processingLocks.delete(lockKey);
            return;
          }
        }

        if (geminiSettings.voice === "texto") {
          const sentMessage = await wbot.sendMessage(msg.key.remoteJid!, {
            text: `\u200e ${cleanedResponse}`
          });
          await verifyMessage(sentMessage!, ticket, contact);
        } else {
          const fileNameWithOutExtension = `${ticket.id}_${Date.now()}`;
          convertTextToSpeechAndSaveToFile(
            keepOnlySpecifiedChars(cleanedResponse),
          `${publicFolder}/${fileNameWithOutExtension}`,
          geminiSettings.voiceKey,
          geminiSettings.voiceRegion,
          geminiSettings.voice,
          "mp3"
        ).then(async () => {
          try {
            const sendMessage = await wbot.sendMessage(msg.key.remoteJid!, {
              audio: { url: `${publicFolder}/${fileNameWithOutExtension}.mp3` },
              mimetype: "audio/mpeg",
              ptt: true
            });
            await verifyMediaMessage(
              sendMessage!,
              ticket,
              contact,
              ticketTraking,
              false,
              false,
              wbot
            );
            fs.unlinkSync(`${publicFolder}/${fileNameWithOutExtension}.mp3`);
            if (fs.existsSync(`${publicFolder}/${fileNameWithOutExtension}.wav`)) {
              fs.unlinkSync(`${publicFolder}/${fileNameWithOutExtension}.wav`);
            }
          } catch (error) {
            logger.error(`Erro para responder com audio: ${error}`);
          }
        });
        }
      }
    } catch (err: any) {
      const status = err.response?.status;
      const errorData = err.response?.data;
      
      logger.error("Erro ao chamar Gemini API:", {
        status,
        data: errorData,
        message: err.message
      });
      
      if (status) {
        const userMessage = interpretGeminiError(status, errorData);
        logger.error(`Erro Gemini: ${userMessage}`);
      }
    } finally {
      // Remover lock após processamento (com timeout de segurança já configurado)
      processingLocks.delete(lockKey);
      logger.debug(`Lock removido: ${lockKey}`);
    }
  } else if (msg.message?.audioMessage) {
    // Nota: Gemini não tem transcrição de áudio nativa como Whisper
    // Por enquanto, vamos apenas logar que áudio foi recebido
    // Se necessário, pode-se usar Whisper da OpenAI ou outro serviço
    logger.warn("Áudio recebido, mas Gemini não suporta transcrição nativa. Use OpenAI para áudio.");
  }
};

