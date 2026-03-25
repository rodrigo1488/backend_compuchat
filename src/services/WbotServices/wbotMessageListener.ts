import path, { join } from "path";
import { promisify } from "util";
import { writeFile } from "fs";
import * as Sentry from "@sentry/node";
import { isNil, head } from "lodash";
import { extension as mimeExtension } from "mime-types";

import {
  downloadMediaMessage,
  extractMessageContent,
  getContentType,
  jidNormalizedUser,
  MessageUpsertType,
  proto,
  WAMessage,
  WAMessageStubType,
  WAMessageUpdate,
  WASocket,
  isPnUser,
  WAMessageAddressingMode,
} from "baileys";
import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";

import { getIO } from "../../libs/socket";
import CreateMessageService, { MessageData } from "../MessageServices/CreateMessageService";
import { logger } from "../../utils/logger";
import CreateOrUpdateContactService from "../ContactServices/CreateOrUpdateContactService";
import FindOrCreateTicketService from "../TicketServices/FindOrCreateTicketService";
import ShowWhatsAppService from "../WhatsappService/ShowWhatsAppService";
import UpdateTicketService from "../TicketServices/UpdateTicketService";
import formatBody from "../../helpers/Mustache";
import { Store } from "../../libs/store";
import TicketTraking from "../../models/TicketTraking";
import UserRating from "../../models/UserRating";
import SendWhatsAppMessage from "./SendWhatsAppMessage";
import moment from "moment";
import Queue from "../../models/Queue";
import QueueOption from "../../models/QueueOption";
import FindOrCreateATicketTrakingService from "../TicketServices/FindOrCreateATicketTrakingService";
import VerifyCurrentSchedule from "../CompanyService/VerifyCurrentSchedule";
import User from "../../models/User";
import Setting from "../../models/Setting";
import Prompt from "../../models/Prompt";
import { cacheLayer } from "../../libs/cache";
import { provider } from "./providers";
import { debounce } from "../../helpers/Debounce";
import { ChatCompletionRequestMessage, Configuration, OpenAIApi } from "openai";
import { isBrazilianNumber, getCountryCode, formatBlockedNumberLog } from "../../helpers/ValidateBrazilianNumber";
import ffmpeg from "fluent-ffmpeg";
import {
  SpeechConfig,
  SpeechSynthesizer,
  AudioConfig
} from "microsoft-cognitiveservices-speech-sdk";
import typebotListener from "../TypebotServices/typebotListener";
import QueueIntegrations from "../../models/QueueIntegrations";
import ShowQueueIntegrationService from "../QueueIntegrationServices/ShowQueueIntegrationService";

import { FlowBuilderModel } from "../../models/FlowBuilder";
import { FlowCampaignModel } from "../../models/FlowCampaign";
import { IOpenAi } from "../../@types/openai";
import { handleGemini } from "../IntegrationsServices/GeminiService";
import ShowPromptService from "../PromptServices/ShowPromptService";
import generateContextSummary from "../AiServices/GenerateContextSummaryService";
import GetTicketWbot from "../../helpers/GetTicketWbot";
import { getChatJid as getChatJidFromHelper } from "../../helpers/chatJid";
import { isValidPhoneNumber as isValidPhoneNumberBase } from "../../helpers/validatePhoneNumber";
import Company from "../../models/Company";
import ListSettingsServiceOne from "../SettingServices/ListSettingsServiceOne";
import ShowUserService from "../UserServices/ShowUserService";
import ListQueuesService from "../QueueService/ListQueuesService";
import Tag from "../../models/Tag";
import SyncTags from "../TagServices/SyncTagsService";
import ExecuteAppointmentFunction from "../AppointmentAIService/ExecuteAppointmentFunction";
import ParseAppointmentCommand from "../AppointmentAIService/ParseAppointmentCommand";
import DashboardCommandService from "../AiServices/DashboardCommandService";

import { IConnections, INodes } from "../WebhookService/DispatchWebHookService";
import { ActionsWebhookService } from "../WebhookService/ActionsWebhookService";
import { WebhookModel } from "../../models/Webhook";

import { differenceInMilliseconds } from "date-fns";
import Whatsapp from "../../models/Whatsapp";
import fs from "node:fs";
import request from "request";

type Session = WASocket & {
  id?: number;
  store?: Store;
};

interface SessionOpenAi extends OpenAIApi {
  id?: number;
}
const sessionsOpenAi: SessionOpenAi[] = [];

interface ImessageUpsert {
  messages: proto.IWebMessageInfo[];
  type: MessageUpsertType;
}

interface IMe {
  name: string;
  id: string;
}

interface IMessage {
  messages: WAMessage[];
  isLatest: boolean;
}

// ============================================================================
// PADRÃO DE IDENTIFICAÇÃO: chatId vs senderId
// ============================================================================
// 
// CONCEITOS FUNDAMENTAIS:
// - chatId (remoteJid): SEMPRE representa o contexto da conversa (chat)
//   - Chat privado: 5511999999999@s.whatsapp.net
//   - Grupo: 120363123456789@g.us
//   - Status/Broadcast: status@broadcast
//
// - senderId (participant): SEMPRE representa o REMETENTE REAL da mensagem
//   - Em grupos/broadcasts: msg.key.participant
//   - Em chats privados: msg.key.remoteJid (participant é null)
//
// REGRAS:
// 1. Para ENVIAR mensagens: use chatId (onde a conversa está)
// 2. Para IDENTIFICAR quem enviou: use senderId
// 3. Para VALIDAÇÕES de usuário (permissões, blacklist): use senderId
// 4. Para IDENTIFICAR o ticket/conversa: use chatId
// ============================================================================

/**
 * Extrai o identificador do CHAT (conversa) da mensagem.
 * Representa ONDE a conversa está acontecendo.
 * Use para: enviar respostas, identificar o ticket, verificar se é grupo.
 */
export const extractChatId = (msg: proto.IWebMessageInfo): string => {
  return msg.key.remoteJid || "";
};

/**
 * Extrai o identificador do REMETENTE REAL da mensagem.
 * Representa QUEM enviou a mensagem.
 * Use para: validações de usuário, permissões, histórico por usuário.
 *
 * PRIORIDADE:
 * 1. participantAlt (Baileys 7.x - PN quando principal é LID)
 * 2. participant (grupos/broadcasts)
 * 3. msg.participant (fallback)
 * 4. remoteJidAlt (Baileys 7.x)
 * 5. remoteJid (chats privados - participant é null)
 *
 * LID/PN (Baileys 7.x): Quando nenhum campo tiver número válido (isValidPhoneNumber),
 * o retorno pode ser um LID (formato numero@lid). Fluxos que exigem número de telefone
 * (ex.: criação de contato, persistência em banco) devem: (1) verificar se o valor
 * termina com @lid; (2) tentar resolver via mapeamento LID→PN (ex.: verifyContact com
 * getPNForLID) ou logar e tratar explicitamente (rejeitar ou usar LID com cuidado).
 */
export const extractSenderId = (msg: proto.IWebMessageInfo): string => {
  const key = msg.key as any;

  // Log removido para reduzir ruído - usar logger.debug se necessário para diagnóstico

  // NOVA LÓGICA: Priorizar campos que NÃO sejam LIDs
  // LIDs têm formato: numero@lid (ex: 52171554951275@lid)
  // Phone Numbers têm formato: numero@s.whatsapp.net

  const candidates = [
    { field: "participantAlt", value: key.participantAlt },
    { field: "participant", value: key.participant },
    { field: "msg.participant", value: msg.participant },
    { field: "remoteJid", value: msg.key.remoteJid },
    { field: "remoteJidAlt", value: key.remoteJidAlt }
  ];

  let selectedField = "";
  let selectedValue = "";

  // PRIMEIRA PASSAGEM: Buscar campos que NÃO sejam LIDs
  for (const candidate of candidates) {
    if (candidate.value) {
      const normalized = jidNormalizedUser(candidate.value);
      const isLid = normalized.includes("@lid");
      const number = normalized.replace(/@.*$/, "").replace(/\D/g, "");
      const isValidNumber = isValidPhoneNumber(number);

      logger.debug(`Avaliando ${candidate.field}: ${normalized} | isLid: ${isLid} | isValid: ${isValidNumber}`);

      // Priorizar campos que não sejam LID E tenham número válido
      if (!isLid && isValidNumber) {
        selectedField = candidate.field;
        selectedValue = normalized;
        // Log removido - usar logger.debug se necessário
        break;
      }
    }
  }

  // SEGUNDA PASSAGEM: Se não encontrou campo válido, usar o primeiro disponível (incluindo LID)
  if (!selectedValue) {
    logger.warn("⚠️ Nenhum campo com número válido encontrado, usando primeiro disponível");
    for (const candidate of candidates) {
      if (candidate.value) {
        selectedField = candidate.field;
        selectedValue = jidNormalizedUser(candidate.value);
        logger.warn(`⚠️ Usando campo ${selectedField} = ${selectedValue} (pode ser LID)`);
        break;
      }
    }
  }

  // Log removido para reduzir ruído - usar logger.debug se necessário para diagnóstico
  return selectedValue;
};

/**
 * Verifica se a mensagem é de um grupo.
 */
export const isGroupMessage = (msg: proto.IWebMessageInfo): boolean => {
  return msg.key.remoteJid?.endsWith("@g.us") || false;
};

/**
 * Verifica se a mensagem é de um broadcast/status.
 */
export const isBroadcastMessage = (msg: proto.IWebMessageInfo): boolean => {
  return msg.key.remoteJid === "status@broadcast";
};

/**
 * Extrai informações padronizadas da mensagem.
 * Retorna chatId, senderId e flags úteis.
 */
export const extractMessageContext = (msg: proto.IWebMessageInfo) => {
  const chatId = extractChatId(msg);
  const senderId = extractSenderId(msg);
  const isGroup = isGroupMessage(msg);
  const isBroadcast = isBroadcastMessage(msg);
  const isFromMe = msg.key.fromMe || false;

  return {
    chatId,           // Onde responder
    senderId,         // Quem enviou
    isGroup,          // É grupo?
    isBroadcast,      // É broadcast/status?
    isFromMe,         // Foi enviada por mim?
    senderNumber: senderId.replace(/@.*$/, "").replace(/\D/g, ""),
    chatNumber: chatId.replace(/@.*$/, "").replace(/\D/g, "")
  };
};

/** Re-export da função centralizada para compatibilidade com imports existentes. */
export const getChatJid = getChatJidFromHelper;

export const isNumeric = (value: string) => /^-?\d+$/.test(value);

/**
 * Valida se um número é um telefone válido (para uso em sender/contato).
 * LIDs e IDs de grupo tendem a ser rejeitados. Quando extractSenderId retorna um LID,
 * isValidPhoneNumber(extraído) será false; use getPNForLID ou verifyContact para resolver.
 * Implementação em helpers/validatePhoneNumber; re-export com log para compatibilidade.
 */
export const isValidPhoneNumber = (number: string): boolean => {
  const result = isValidPhoneNumberBase(number);
  if (result) {
    logger.debug(`✅ Número válido: ${number.replace(/\D/g, "")}`);
  }
  return result;
};

const writeFileAsync = promisify(writeFile);

const getTypeMessage = (msg: proto.IWebMessageInfo): string => {
  return getContentType(msg.message);
};

function hasCaption(title: string, fileName: string) {
  if (!title || !fileName) return false;

  const fileNameExtension = fileName.substring(fileName.lastIndexOf('.') + 1);

  return !fileName.includes(`${title}.${fileNameExtension}`)
}

export function validaCpfCnpj(val) {
  if (val.length == 11) {
    var cpf = val.trim();

    cpf = cpf.replace(/\./g, "");
    cpf = cpf.replace("-", "");
    cpf = cpf.split("");

    var v1 = 0;
    var v2 = 0;
    var aux = false;

    for (var i = 1; cpf.length > i; i++) {
      if (cpf[i - 1] != cpf[i]) {
        aux = true;
      }
    }

    if (aux == false) {
      return false;
    }

    for (var i = 0, p = 10; cpf.length - 2 > i; i++, p--) {
      v1 += cpf[i] * p;
    }

    v1 = (v1 * 10) % 11;

    if (v1 == 10) {
      v1 = 0;
    }

    if (v1 != cpf[9]) {
      return false;
    }

    for (var i = 0, p = 11; cpf.length - 1 > i; i++, p--) {
      v2 += cpf[i] * p;
    }

    v2 = (v2 * 10) % 11;

    if (v2 == 10) {
      v2 = 0;
    }

    if (v2 != cpf[10]) {
      return false;
    } else {
      return true;
    }
  } else if (val.length == 14) {
    var cnpj = val.trim();

    cnpj = cnpj.replace(/\./g, "");
    cnpj = cnpj.replace("-", "");
    cnpj = cnpj.replace("/", "");
    cnpj = cnpj.split("");

    var v1 = 0;
    var v2 = 0;
    var aux = false;

    for (var i = 1; cnpj.length > i; i++) {
      if (cnpj[i - 1] != cnpj[i]) {
        aux = true;
      }
    }

    if (aux == false) {
      return false;
    }

    for (var i = 0, p1 = 5, p2 = 13; cnpj.length - 2 > i; i++, p1--, p2--) {
      if (p1 >= 2) {
        v1 += cnpj[i] * p1;
      } else {
        v1 += cnpj[i] * p2;
      }
    }

    v1 = v1 % 11;

    if (v1 < 2) {
      v1 = 0;
    } else {
      v1 = 11 - v1;
    }

    if (v1 != cnpj[12]) {
      return false;
    }

    for (var i = 0, p1 = 6, p2 = 14; cnpj.length - 1 > i; i++, p1--, p2--) {
      if (p1 >= 2) {
        v2 += cnpj[i] * p1;
      } else {
        v2 += cnpj[i] * p2;
      }
    }

    v2 = v2 % 11;

    if (v2 < 2) {
      v2 = 0;
    } else {
      v2 = 11 - v2;
    }

    if (v2 != cnpj[13]) {
      return false;
    } else {
      return true;
    }
  } else {
    return false;
  }
}

function timeout(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function sleep(time: number) {
  await timeout(time);
}

export const sendMessageImage = async (
  wbot: Session,
  contact,
  ticket: Ticket,
  url: string,
  caption: string
) => {
  let sentMessage;
  // CORREÇÃO: Usar getChatJid para obter o destino correto do chat
  // Em grupos, contact é o remetente, mas devemos enviar para o grupo (ticket.contact)
  const chatJid = getChatJid(ticket);

  try {
    sentMessage = await wbot.sendMessage(
      chatJid,
      {
        image: url
          ? { url }
          : fs.readFileSync(`public/temp/${caption}-${makeid(10)}`),
        fileName: caption,
        caption: caption,
        mimetype: "image/jpeg"
      }
    );
  } catch (error) {
    sentMessage = await wbot.sendMessage(
      chatJid,
      {
        text: formatBody(
          "Não consegui enviar a imagem, tente novamente!",
          contact
        )
      }
    );
  }
  verifyMessage(sentMessage, ticket, contact);
};

export const sendMessageLink = async (
  wbot: Session,
  contact: Contact,
  ticket: Ticket,
  url: string,
  caption: string
) => {
  let sentMessage;
  // CORREÇÃO: Usar getChatJid para obter o destino correto do chat
  const chatJid = getChatJid(ticket);

  try {
    sentMessage = await wbot.sendMessage(
      chatJid,
      {
        document: url
          ? { url }
          : fs.readFileSync(`public/temp/${caption}-${makeid(10)}`),
        fileName: caption,
        caption: caption,
        mimetype: "application/pdf"
      }
    );
  } catch (error) {
    sentMessage = await wbot.sendMessage(
      chatJid,
      {
        text: formatBody("Não consegui enviar o PDF, tente novamente!", contact)
      }
    );
  }
  verifyMessage(sentMessage, ticket, contact);
};

export function makeid(length) {
  var result = "";
  var characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var charactersLength = characters.length;
  for (var i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

const getBodyButton = (msg: proto.IWebMessageInfo): string => {
  if (
    msg.key.fromMe &&
    msg?.message?.viewOnceMessage?.message?.buttonsMessage?.contentText
  ) {
    let bodyMessage = `*${msg?.message?.viewOnceMessage?.message?.buttonsMessage?.contentText}*`;

    for (const buton of msg.message?.viewOnceMessage?.message?.buttonsMessage
      ?.buttons) {
      bodyMessage += `\n\n${buton.buttonText?.displayText}`;
    }
    return bodyMessage;
  }

  if (msg.key.fromMe && msg?.message?.viewOnceMessage?.message?.listMessage) {
    let bodyMessage = `*${msg?.message?.viewOnceMessage?.message?.listMessage?.description}*`;
    for (const buton of msg.message?.viewOnceMessage?.message?.listMessage
      ?.sections) {
      for (const rows of buton.rows) {
        bodyMessage += `\n\n${rows.title}`;
      }
    }

    return bodyMessage;
  }
};

const msgLocation = (image, latitude, longitude) => {
  if (image) {
    var b64 = Buffer.from(image).toString("base64");

    let data = `data:image/png;base64, ${b64} | https://maps.google.com/maps?q=${latitude}%2C${longitude}&z=17&hl=pt-BR|${latitude}, ${longitude} `;
    return data;
  }
};

export const getBodyMessage = (msg: proto.IWebMessageInfo): string | null => {
  try {
    let type = getTypeMessage(msg);

    const types = {
      conversation: msg?.message?.conversation,
      editedMessage:
        msg?.message?.editedMessage?.message?.protocolMessage?.editedMessage
          ?.conversation,
      imageMessage: msg.message?.imageMessage?.caption,
      videoMessage: msg.message?.videoMessage?.caption,
      extendedTextMessage: msg.message?.extendedTextMessage?.text,
      buttonsResponseMessage:
        msg.message?.buttonsResponseMessage?.selectedButtonId,
      templateButtonReplyMessage:
        msg.message?.templateButtonReplyMessage?.selectedId,
      messageContextInfo:
        msg.message?.buttonsResponseMessage?.selectedButtonId ||
        msg.message?.listResponseMessage?.title,
      buttonsMessage:
        getBodyButton(msg) ||
        msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId,
      viewOnceMessage:
        getBodyButton(msg) ||
        msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId,
      stickerMessage: "sticker",
      contactMessage: msg.message?.contactMessage?.vcard,
      contactsArrayMessage: "varios contatos",
      //locationMessage: `Latitude: ${msg.message.locationMessage?.degreesLatitude} - Longitude: ${msg.message.locationMessage?.degreesLongitude}`,
      locationMessage: msgLocation(
        msg.message?.locationMessage?.jpegThumbnail,
        msg.message?.locationMessage?.degreesLatitude,
        msg.message?.locationMessage?.degreesLongitude
      ),
      liveLocationMessage: `Latitude: ${msg.message?.liveLocationMessage?.degreesLatitude} - Longitude: ${msg.message?.liveLocationMessage?.degreesLongitude}`,
      documentMessage: msg.message?.documentMessage?.caption,
      documentWithCaptionMessage:
        msg.message?.documentWithCaptionMessage?.message?.documentMessage
          ?.caption,
      audioMessage: "Áudio",
      listMessage:
        getBodyButton(msg) || msg.message?.listResponseMessage?.title,
      listResponseMessage:
        msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId,
      reactionMessage: msg.message?.reactionMessage?.text || "reaction"
    };

    const objKey = Object.keys(types).find(key => key === type);

    if (!objKey) {
      logger.warn(`#### Nao achou o type 152: ${type}
${JSON.stringify(msg)}`);
      Sentry.setExtra("Mensagem", { BodyMsg: msg.message, msg, type });
      Sentry.captureException(
        new Error("Novo Tipo de Mensagem em getTypeMessage")
      );
    }
    return types[type];
  } catch (error) {
    Sentry.setExtra("Error getTypeMessage", { msg, BodyMsg: msg.message });
    Sentry.captureException(error);
    console.log(error);
  }
};

export const getQuotedMessage = (msg: proto.IWebMessageInfo): any => {
  const body =
    msg.message.imageMessage.contextInfo ||
    msg.message.videoMessage.contextInfo ||
    msg.message?.documentMessage ||
    msg.message.extendedTextMessage.contextInfo ||
    msg.message.buttonsResponseMessage.contextInfo ||
    msg.message.listResponseMessage.contextInfo ||
    msg.message.templateButtonReplyMessage.contextInfo ||
    msg.message.buttonsResponseMessage?.contextInfo ||
    msg?.message?.buttonsResponseMessage?.selectedButtonId ||
    msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg?.message?.listResponseMessage?.singleSelectReply.selectedRowId ||
    msg.message.listResponseMessage?.contextInfo;
  msg.message.senderKeyDistributionMessage;

  // testar isso

  return extractMessageContent(body[Object.keys(body).values().next().value]);
};
export const getQuotedMessageId = (msg: proto.IWebMessageInfo) => {
  // Reações usam reactionMessage.key.id para referenciar a mensagem reagida
  if (msg?.message?.reactionMessage) {
    return msg.message.reactionMessage?.key?.id ?? null;
  }
  const body = extractMessageContent(msg.message)[
    Object.keys(msg?.message).values().next().value
  ];
  return body?.contextInfo?.stanzaId ?? null;
};

const getMeSocket = (wbot: Session): IMe => {
  return {
    id: jidNormalizedUser((wbot as WASocket).user.id),
    name: (wbot as WASocket).user.name
  };
};

/**
 * Obtém o JID do REMETENTE da mensagem.
 * 
 * IMPORTANTE: Esta função retorna QUEM enviou a mensagem, não onde responder.
 * - Em grupos: retorna o participant (membro que enviou)
 * - Em privado: retorna o remoteJid (é o próprio remetente)
 * - Se fromMe: retorna o JID do bot
 * 
 * @deprecated Prefira usar extractSenderId() para novo código
 */
const getSenderMessage = (
  msg: proto.IWebMessageInfo,
  wbot: Session
): string => {
  const me = getMeSocket(wbot);
  if (msg.key.fromMe) return me.id;

  // Usa a função padronizada para extrair o senderId
  return extractSenderId(msg);
};

/**
 * Obtém os dados do CONTATO associado à mensagem.
 * 
 * LÓGICA:
 * - Mensagem enviada por mim em PRIVADO: contato é o DESTINATÁRIO (remoteJid/chatId)
 * - Mensagem recebida em PRIVADO: contato é o REMETENTE (senderId = remoteJid)
 * - Mensagem em GRUPO: contato é o REMETENTE (senderId = participant)
 * 
 * Isso é necessário porque em tickets privados, quando ENVIAMOS uma mensagem,
 * o ticket deve ser do contato para quem enviamos, não nosso.
 */
const getContactMessage = async (msg: proto.IWebMessageInfo, wbot: Session) => {
  const { chatId, senderId, isGroup, isFromMe } = extractMessageContext(msg);
  let contactJid: string;

  // Log removido para reduzir ruído

  // Lógica de identificação do contato:
  // 1. Mensagem enviada por mim em chat privado → contato é o DESTINATÁRIO (chatId)
  // 2. Qualquer outro caso → contato é o REMETENTE (senderId)
  if (!isGroup && isFromMe) {
    // Em privado, quando EU envio, o contato do ticket é o destinatário
    const key = msg.key as any;
    contactJid = key.remoteJidAlt || chatId;
    // Log removido para reduzir ruído
  } else {
    // Em grupos ou mensagens recebidas, o contato é quem enviou
    contactJid = senderId;
    // Log removido para reduzir ruído
  }

  // Extrair número limpo do JID
  const rawNumber = contactJid ? contactJid.replace(/@.*$/, "").replace(/\D/g, "") : "";

  const result = {
    id: contactJid || "",
    name: isFromMe ? rawNumber : msg.pushName
  };

  // Log removido para reduzir ruído - usar logger.debug se necessário para diagnóstico

  return result;
};

const downloadMedia = async (msg: proto.IWebMessageInfo) => {
  let buffer;
  try {
    // Garantir que msg tem key antes de passar para downloadMediaMessage
    if (!msg.key) {
      throw new Error("Message key is missing");
    }
    buffer = await downloadMediaMessage(msg as WAMessage, "buffer", {});
  } catch (err) {
    console.error("Erro ao baixar mídia:", err);

    // Trate o erro de acordo com as suas necessidades
  }

  let filename = msg.message?.documentMessage?.fileName || "";

  const mineType =
    msg.message?.imageMessage ||
    msg.message?.audioMessage ||
    msg.message?.videoMessage ||
    msg.message?.stickerMessage ||
    msg.message?.documentMessage ||
    msg.message?.documentWithCaptionMessage?.message?.documentMessage ||
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
      ?.imageMessage ||
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage;

  if (!mineType) console.log(msg);

  if (!filename) {
    const ext = mimeExtension(mineType.mimetype);
    filename = `${new Date().getTime()}.${ext}`;
  } else {
    filename = `${new Date().getTime()}_${filename}`;
  }

  const media = {
    data: buffer,
    mimetype: mineType.mimetype,
    filename
  };

  return media;
};

/**
 * Resolve ou cria contato a partir do remetente da mensagem (msgContact.id pode vir de extractSenderId).
 * Quando o id é um LID (numero@lid), tentamos resolver para PN via getPNForLID antes de validar
 * número; fluxos que dependem de número de telefone devem usar verifyContact para obter contato.
 */
const verifyContact = async (
  msgContact: IMe,
  wbot: Session,
  companyId: number
): Promise<Contact> => {
  let profilePicUrl: string;

  // Normalizar o ID do contato para garantir formato correto
  const normalizedContactId = msgContact.id.includes("g.us")
    ? msgContact.id
    : jidNormalizedUser(msgContact.id);

  // Log removido para reduzir ruído - usar logger.debug se necessário para diagnóstico

  try {
    profilePicUrl = await wbot.profilePictureUrl(normalizedContactId);
  } catch (e) {
    Sentry.captureException(e);
    profilePicUrl = `${process.env.FRONTEND_URL}/nopicture.png`;
  }

  // Extrair número do JID normalizado (remove @s.whatsapp.net ou @g.us)
  const isGroup = normalizedContactId.includes("g.us");
  let contactNumber = isGroup
    ? normalizedContactId
    : normalizedContactId.replace(/@.*$/, "").replace(/\D/g, "");

  // Log removido para reduzir ruído - usar logger.debug se necessário para diagnóstico

  // Tentar resolver LID para PN (Phone Number)
  if (!isGroup && normalizedContactId.includes("@lid")) {
    // Log removido para reduzir ruído

    // ESTRATÉGIA 1: Usar lidMapping.getPNForLID
    const lidMappingStore = (wbot as any)?.signalRepository?.lidMapping;
    const getPNForLID = lidMappingStore?.getPNForLID;
    if (typeof getPNForLID === "function") {
      try {
        const pn = await Promise.resolve(getPNForLID(normalizedContactId));
        if (pn) {
          const resolvedNumber = pn.replace(/@.*$/, "").replace(/\D/g, "");
          // Log removido para reduzir ruído
          contactNumber = resolvedNumber;
        } else {
          logger.warn('⚠️ LID não pôde ser resolvido via lidMapping - retornou null');
        }
      } catch (e) {
        logger.error('❌ Erro ao resolver LID via lidMapping:', e);
        Sentry.captureException(e);
      }
    } else {
      logger.warn('⚠️ Função getPNForLID não disponível no wbot');
    }

    // ESTRATÉGIA 2: Se ainda inválido, tentar onWhatsApp
    if (!isValidPhoneNumber(contactNumber)) {
      // Log removido para reduzir ruído
      try {
        const onWhatsAppResult = await wbot.onWhatsApp(normalizedContactId);
        if (onWhatsAppResult && onWhatsAppResult.length > 0) {
          const jid = onWhatsAppResult[0].jid;
          const phoneNumber = jid.replace(/@.*$/, "").replace(/\D/g, "");
          // Log removido para reduzir ruído
          contactNumber = phoneNumber;
        } else {
          logger.warn('⚠️ onWhatsApp não retornou resultados');
        }
      } catch (e) {
        logger.error('❌ Erro ao usar onWhatsApp:', e);
        Sentry.captureException(e);
      }
    }

    // ESTRATÉGIA 3: Se o JID original for diferente, tentar usar ele
    if (!isValidPhoneNumber(contactNumber) && msgContact.id !== normalizedContactId) {
      // Log removido para reduzir ruído
      const originalNumber = msgContact.id.replace(/@.*$/, "").replace(/\D/g, "");
      if (isValidPhoneNumber(originalNumber)) {
        // Log removido para reduzir ruído
        contactNumber = originalNumber;
      }
    }
  }

  // VALIDAÇÃO DO NÚMERO EXTRAÍDO
  if (!isGroup) {
    const isValid = isValidPhoneNumber(contactNumber);

    // Log removido para reduzir ruído - usar logger.debug se necessário para diagnóstico

    if (!isValid) {
      logger.error('❌ NÚMERO INVÁLIDO DETECTADO!', {
        número: contactNumber,
        comprimento: contactNumber.length,
        jidOriginal: msgContact.id,
        jidNormalizado: normalizedContactId,
        empresa: companyId
      });

      Sentry.setExtra("Número Inválido Detectado", {
        número: contactNumber,
        comprimento: contactNumber.length,
        jidOriginal: msgContact.id,
        jidNormalizado: normalizedContactId,
        empresa: companyId
      });
      Sentry.captureMessage("CRÍTICO: Número de telefone inválido detectado no verifyContact");

      // IMPORTANTE: Não salvar número inválido - isso causará problemas de envio
      throw new Error(`Número de telefone inválido: ${contactNumber} (${contactNumber.length} dígitos) - JID: ${normalizedContactId}`);
    }
  }

  // Log detalhado para debug quando número parecer incorreto
  if (!isGroup) {
    // Log quando número é muito longo (possível número incorreto)
    if (contactNumber.length > 15) {
      logger.warn(`⚠️ NÚMERO SUSPEITO (muito longo): ${contactNumber} | JID original: ${msgContact.id} | JID normalizado: ${normalizedContactId} | Empresa: ${companyId}`);
      Sentry.setExtra("Número Suspeito", {
        número: contactNumber,
        jidOriginal: msgContact.id,
        jidNormalizado: normalizedContactId,
        empresa: companyId
      });
      Sentry.captureMessage("Número de contato suspeito detectado (muito longo)");
    }

    // Validar se o número começa com código de país conhecido
    if (contactNumber.length >= 10) {
      const countryCode = contactNumber.substring(0, 2);
      const knownCountryCodes = ["55", "52", "1", "44", "49", "33", "34", "39", "41", "43", "45", "46", "47", "48", "51", "53", "54", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98"];

      if (!knownCountryCodes.includes(countryCode) && contactNumber.length > 12) {
        logger.warn(`⚠️ NÚMERO COM CÓDIGO DE PAÍS NÃO RECONHECIDO: ${contactNumber} | Código: ${countryCode} | JID: ${normalizedContactId} | Empresa: ${companyId}`);
        Sentry.setExtra("Número com Código Inválido", {
          número: contactNumber,
          códigoPaís: countryCode,
          jid: normalizedContactId,
          empresa: companyId
        });
        Sentry.captureMessage("Número de contato com código de país não reconhecido");
      }
    }

    // Log informativo para todos os números (ajuda no debug)
    logger.debug(`📞 Contato processado: ${contactNumber} | JID: ${normalizedContactId} | Empresa: ${companyId}`);
  }

  const contactData = {
    name: msgContact?.name || contactNumber,
    number: contactNumber,
    profilePicUrl,
    isGroup,
    companyId,
    whatsappId: wbot.id
  };

  const contact = await CreateOrUpdateContactService(contactData);

  return contact;
};

const verifyQuotedMessage = async (
  msg: proto.IWebMessageInfo
): Promise<Message | null> => {
  if (!msg) return null;
  const quoted = getQuotedMessageId(msg);

  if (!quoted) return null;

  const quotedMsg = await Message.findOne({
    where: { id: quoted }
  });

  if (!quotedMsg) return null;

  return quotedMsg;
};

const sanitizeName = (name: string): string => {
  let sanitized = name.split(" ")[0];
  // Remove apenas caracteres especiais problemáticos, mantendo acentos e letras Unicode
  sanitized = sanitized.replace(/[^\p{L}\p{N}]/gu, "");
  return sanitized.substring(0, 60);
};

export const convertTextToSpeechAndSaveToFile = (
  text: string,
  filename: string,
  subscriptionKey: string,
  serviceRegion: string,
  voice: string = "pt-BR-FabioNeural",
  audioToFormat: string = "mp3"
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const speechConfig = SpeechConfig.fromSubscription(
      subscriptionKey,
      serviceRegion
    );
    speechConfig.speechSynthesisVoiceName = voice;
    const audioConfig = AudioConfig.fromAudioFileOutput(`${filename}.wav`);
    const synthesizer = new SpeechSynthesizer(speechConfig, audioConfig);
    synthesizer.speakTextAsync(
      text,
      result => {
        if (result) {
          convertWavToAnotherFormat(
            `${filename}.wav`,
            `${filename}.${audioToFormat}`,
            audioToFormat
          )
            .then(output => {
              resolve();
            })
            .catch(error => {
              console.error(error);
              reject(error);
            });
        } else {
          reject(new Error("No result from synthesizer"));
        }
        synthesizer.close();
      },
      error => {
        console.error(`Error: ${error}`);
        synthesizer.close();
        reject(error);
      }
    );
  });
};

const convertWavToAnotherFormat = (
  inputPath: string,
  outputPath: string,
  toFormat: string
) => {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inputPath)
      .toFormat(toFormat)
      .on("end", () => resolve(outputPath))
      .on("error", (err: { message: any }) =>
        reject(new Error(`Error converting file: ${err.message}`))
      )
      .save(outputPath);
  });
};

const deleteFileSync = (path: string): void => {
  try {
    fs.unlinkSync(path);
  } catch (error) {
    console.error("Erro ao deletar o arquivo:", error);
  }
};

export const keepOnlySpecifiedChars = (str: string) => {
  return str.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚâêîôûÂÊÎÔÛãõÃÕçÇ!?.,;:\s]/g, "");
};

const handleGeminiInListener = async (
  msg: proto.IWebMessageInfo,
  wbot: Session,
  ticket: Ticket,
  contact: Contact,
  mediaSent: Message | undefined,
  ticketTraking: TicketTraking = null,
  geminiSettings = null
): Promise<void> => {
  // REGRA PARA DESABILITAR O BOT PARA ALGUM CONTATO
  if (contact.disableBot) {
    return;
  }

  const bodyMessage = getBodyMessage(msg);

  if (!bodyMessage) return;

  let prompt = null;

  // Se geminiSettings foi passado (de flowbuilder), usar ele
  if (geminiSettings) {
    prompt = geminiSettings;
  } else {
    // Buscar prompt do WhatsApp
    let { prompt: whatsappPrompt } = await ShowWhatsAppService(wbot.id, ticket.companyId);
    if (whatsappPrompt && whatsappPrompt.provider === "gemini") {
      prompt = whatsappPrompt;
    }

    // Se não encontrou no WhatsApp, buscar da fila
    if (!prompt && !isNil(ticket?.queue?.prompt) && ticket.queue.prompt.provider === "gemini") {
      prompt = ticket.queue.prompt;
    }

    // Se não encontrou na fila, buscar do ticket
    if (!prompt && ticket.promptId) {
      try {
        const ticketPrompt = await ShowPromptService({
          promptId: ticket.promptId,
          companyId: ticket.companyId
        });
        if (ticketPrompt && ticketPrompt.provider === "gemini") {
          prompt = ticketPrompt;
        }
      } catch (err) {
        // Prompt não encontrado, continuar
      }
    }
  }

  if (!prompt) return;

  if (msg.messageStubType) return;

  // Converter prompt para formato IGemini
  const geminiSettingsData = {
    name: prompt.name,
    prompt: prompt.prompt,
    voice: prompt.voice || "texto",
    voiceKey: prompt.voiceKey || "",
    voiceRegion: prompt.voiceRegion || "",
    maxTokens: prompt.maxTokens,
    temperature: prompt.temperature,
    queueId: prompt.queueId,
    maxMessages: prompt.maxMessages,
    canSendInternalMessages: prompt.canSendInternalMessages || false,
    canTransferToAgent: prompt.canTransferToAgent || false,
    transferQueueId: prompt.transferQueueId || null,
    permitirCriarAgendamentos: prompt.permitirCriarAgendamentos || false
  };

  await handleGemini(
    geminiSettingsData,
    msg,
    wbot,
    ticket,
    contact,
    mediaSent,
    ticketTraking
  );
};

/**
 * Envia mensagem automática de transferência para o cliente
 */
// Map para rastrear processamentos em andamento e evitar duplicatas (OpenAI)
const openAiProcessingLocks = new Map<string, number>();

// Map para debounce de processamento de IA (cancelar processamentos anteriores se nova mensagem chegar)
const aiProcessingDebounces = new Map<number, NodeJS.Timeout>();

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

// Função para detectar se a mensagem é um comando de agendamento ou tarefa
const detectCommandType = (message: string): "appointment" | "task" | "none" => {
  const lower = message.toLowerCase().trim();
  
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
    "agende uma reunião", "agendar uma reunião", "marcar uma reunião",
    "agende uma", "agendar uma", "agende para", "agendar para"
  ];
  
  const taskKeywords = [
    "criar tarefa", "criar uma tarefa", "nova tarefa",
    "tarefa", "tarefas",
    "lembre-me", "lembrar", "lembre", "me lembre",
    "lembrar de", "não esquecer", "nao esquecer",
    "criar lembrete", "lembrete"
  ];
  
  // "agende" e "agendar" sempre indicam agendamento
  const alwaysAppointment = ["agende", "agendar", "agendamento", "agendamentos", "agenda"];
  if (alwaysAppointment.some(keyword => lower.includes(keyword))) {
    return "appointment";
  }
  
  // Verificar outras palavras-chave
  if (appointmentKeywords.some(keyword => lower.includes(keyword))) {
    return "appointment";
  }
  
  if (taskKeywords.some(keyword => lower.includes(keyword))) {
    return "task";
  }
  
  return "none";
};

const handleOpenAi = async (
  msg: proto.IWebMessageInfo,
  wbot: Session,
  ticket: Ticket,
  contact: Contact,
  mediaSent: Message | undefined,
  ticketTraking: TicketTraking = null,
  openAiSettings = null
): Promise<void> => {

  // REGRA PARA DESABILITAR O BOT PARA ALGUM CONTATO
  if (contact.disableBot) {
    return;
  }

  const bodyMessage = getBodyMessage(msg);

  if (!bodyMessage) {
    logger.debug(`handleOpenAi: Sem bodyMessage para ticket ${ticket.id}`);
    return;
  }

  // Lock para evitar processamento duplicado da mesma mensagem
  const messageId = msg.key.id || `${ticket.id}-${Date.now()}`;
  const lockKey = `openai-${ticket.id}-${messageId}`;
  
  // Verificar se já está processando
  if (openAiProcessingLocks.has(lockKey)) {
    const lockTime = openAiProcessingLocks.get(lockKey)!;
    const timeSinceLock = Date.now() - lockTime;
    
    // Se o lock é muito antigo (>30s), pode ser um lock travado, remover
    if (timeSinceLock > 30000) {
      logger.warn(`Lock antigo detectado e removido (OpenAI): ${lockKey} (${timeSinceLock}ms)`);
      openAiProcessingLocks.delete(lockKey);
    } else {
      logger.warn(`Mensagem já está sendo processada (OpenAI), ignorando duplicata: ${lockKey}`);
      return;
    }
  }
  
  // Adicionar lock
  openAiProcessingLocks.set(lockKey, Date.now());
  
  // Timeout de segurança para remover lock (30 segundos)
  setTimeout(() => {
    if (openAiProcessingLocks.has(lockKey)) {
      openAiProcessingLocks.delete(lockKey);
      logger.debug(`Lock removido automaticamente (timeout): ${lockKey}`);
    }
  }, 30000);

  let prompt = null;

  // Primeiro, tentar usar openAiSettings se fornecido
  if (openAiSettings) {
    prompt = openAiSettings;
    logger.info(`handleOpenAi: Usando openAiSettings fornecido`);
  }

  // Se não, buscar do WhatsApp
  if (!prompt) {
    try {
      const whatsappData = await ShowWhatsAppService(wbot.id, ticket.companyId);
      prompt = whatsappData.prompt;
      if (prompt) {
        logger.info(`handleOpenAi: Prompt encontrado no WhatsApp - ${prompt.name}, Provider: ${prompt.provider}`);
      }
    } catch (err: any) {
      logger.error(`handleOpenAi: Erro ao buscar WhatsApp: ${err.message}`);
    }
  }

  // Se não encontrou no WhatsApp, tentar buscar pelo promptId do ticket
  if (!prompt && ticket.promptId) {
    try {
      const ticketPrompt = await ShowPromptService({
        promptId: ticket.promptId,
        companyId: ticket.companyId
      });
      if (ticketPrompt) {
        prompt = ticketPrompt;
        logger.info(`handleOpenAi: Prompt encontrado no ticket - ${prompt.name}, Provider: ${prompt.provider}`);
      }
    } catch (err: any) {
      logger.error(`handleOpenAi: Erro ao buscar prompt do ticket: ${err.message}`);
    }
  }

  // Se ainda não encontrou, tentar buscar da fila
  if (!prompt && !isNil(ticket?.queue?.prompt)) {
    prompt = ticket.queue.prompt;
    logger.info(`handleOpenAi: Prompt encontrado na fila - ${prompt.name}, Provider: ${prompt.provider}`);
  }

  // Se ainda não encontrou, tentar buscar pelo promptId do WhatsApp diretamente
  if (!prompt && wbot.id) {
    try {
      const whatsapp = await ShowWhatsAppService(wbot.id, ticket.companyId);
      if (whatsapp?.promptId) {
        const whatsappPrompt = await ShowPromptService({
          promptId: whatsapp.promptId,
          companyId: ticket.companyId
        });
        if (whatsappPrompt) {
          prompt = whatsappPrompt;
          logger.info(`handleOpenAi: Prompt encontrado pelo promptId do WhatsApp - ${prompt.name}, Provider: ${prompt.provider}`);
        }
      }
    } catch (err: any) {
      logger.error(`handleOpenAi: Erro ao buscar prompt pelo promptId do WhatsApp: ${err.message}`);
    }
  }

  if (!prompt) {
    logger.warn(`⚠️ handleOpenAi: Prompt não encontrado - Ticket: ${ticket.id}, WhatsApp: ${wbot.id}, Empresa: ${ticket.companyId}`);
    return;
  }

  // Verificar se o provider é OpenAI (ou não especificado, default para OpenAI)
  if (prompt.provider && prompt.provider !== "openai" && prompt.provider !== "gemini") {
    logger.warn(`⚠️ handleOpenAi: Provider desconhecido '${prompt.provider}', usando OpenAI como padrão`);
  }

  logger.info(`✅ handleOpenAi: Iniciando bot - Ticket: ${ticket.id}, Prompt: ${prompt.name || 'N/A'}, Provider: ${prompt.provider || 'openai'}`);

  if (msg.messageStubType) return;

  // PRIORIDADE: Verificar se a mensagem é um comando de agendamento/tarefa ANTES de processar com IA
  const commandType = detectCommandType(bodyMessage);
  
  if (commandType !== "none" && prompt.permitirCriarAgendamentos) {
    try {
      logger.info(`🔍 [OpenAI] Comando detectado: ${commandType} - Processando...`);
      
      // Buscar userId: usar do ticket se disponível, senão buscar primeiro usuário da empresa
      let userId = ticket.userId;
      if (!userId) {
        const ticketUser = await User.findOne({
          where: { companyId: ticket.companyId },
          order: [["id", "ASC"]],
          limit: 1
        });
        userId = ticketUser?.id || 1; // Fallback para userId padrão
      }
      
      const commandResult = await DashboardCommandService({
        companyId: ticket.companyId,
        userId,
        command: bodyMessage
      });

      logger.info(`📋 [OpenAI] Resultado do comando:`, {
        success: commandResult.success,
        action: commandResult.action,
        hasTask: !!commandResult.task,
        hasAppointment: !!commandResult.appointment
      });

      // Se o comando foi executado com sucesso, enviar mensagem automática SEM chamar IA
      if (commandResult.success) {
        let responseText = "";
        
        if (commandResult.action === "create_task" && commandResult.task) {
          responseText = `✅ Tarefa criada com sucesso!\n\n📋 ${commandResult.task.title}`;
          if (commandResult.task.description) {
            responseText += `\n\n${commandResult.task.description}`;
          }
          if (commandResult.task.dueDate) {
            const dueDate = new Date(commandResult.task.dueDate);
            responseText += `\n\n📅 Prazo: ${dueDate.toLocaleString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit"
            })}`;
          }
        } else if (commandResult.action === "create_appointment" && commandResult.appointment) {
          responseText = `✅ Agendamento concluído!\n\n📅 ${commandResult.appointment.title}`;
          if (commandResult.appointment.description) {
            responseText += `\n\n${commandResult.appointment.description}`;
          }
          if (commandResult.appointment.startTime) {
            const startTime = new Date(commandResult.appointment.startTime);
            const endTime = commandResult.appointment.endTime 
              ? new Date(commandResult.appointment.endTime)
              : new Date(startTime.getTime() + 60 * 60 * 1000);
            
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
            
            responseText += `\n\n🕐 Horário: ${startDateStr} das ${startTimeStr} às ${endTimeStr}`;
          }
        } else {
          responseText = commandResult.message || "✅ Comando executado com sucesso!";
        }

        logger.info(`✅ [OpenAI] ${commandResult.action === "create_appointment" ? "Agendamento" : "Tarefa"} criado com sucesso - Enviando mensagem automática`);
        
        // Enviar mensagem automática e retornar SEM chamar IA
        const chatJid = getChatJid(ticket);
        const sentMessage = await wbot.sendMessage(chatJid, {
          text: responseText
        });
        await verifyMessage(sentMessage!, ticket, contact);
        openAiProcessingLocks.delete(lockKey); // Remover lock antes de retornar
        return;
      } else {
        // Comando não foi executado - continuar com IA para explicar o problema
        logger.warn(`⚠️ [OpenAI] Comando não executado: ${commandResult.message}`);
        // Continuar com o fluxo normal da IA para que ela possa explicar o problema
      }
    } catch (err: any) {
      logger.error(`❌ [OpenAI] Erro ao processar comando no chat:`, err);
      // Em caso de erro, enviar mensagem de erro e retornar SEM chamar IA
      const chatJid = getChatJid(ticket);
      const errorResponseText = `❌ Não foi possível processar o comando: ${err.message || "Erro desconhecido"}. Por favor, tente novamente.`;
      const sentErrorMessage = await wbot.sendMessage(chatJid, {
        text: errorResponseText
      });
      await verifyMessage(sentErrorMessage!, ticket, contact);
      openAiProcessingLocks.delete(lockKey); // Remover lock antes de retornar
      return;
    }
  }

  const publicFolder: string = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "public"
  );

  let openai: SessionOpenAi;
  const openAiIndex = sessionsOpenAi.findIndex(s => s.id === wbot.id);

  if (openAiIndex === -1) {
    // Buscar API key das Settings em vez do prompt
    const openaiSetting = await Setting.findOne({
      where: {
        key: "openaiApiKey",
        companyId: ticket.companyId
      }
    });

    if (!openaiSetting?.value) {
      logger.error(`API Key do OpenAI não configurada para empresa ${ticket.companyId}`);
      return;
    }

    const configuration = new Configuration({
      apiKey: openaiSetting.value
    });
    openai = new OpenAIApi(configuration);
    openai.id = wbot.id;
    sessionsOpenAi.push(openai);
  } else {
    openai = sessionsOpenAi[openAiIndex];
  }

  // Limitar histórico para não consumir todos os tokens
  // Pegar apenas as últimas mensagens relevantes (máximo 10 para economizar tokens)
  const maxHistoryMessages = Math.min(prompt.maxMessages, 10);

  const messages = await Message.findAll({
    where: { ticketId: ticket.id },
    order: [["createdAt", "DESC"]],
    limit: maxHistoryMessages
  });

  // Buscar filas disponíveis para permitir que a IA escolha
  const availableQueues = await ListQueuesService({ companyId: ticket.companyId });
  const queuesList = availableQueues.map(q => `- ${q.name} (ID: ${q.id})`).join('\n');

  // Buscar tags disponíveis se canChangeTag estiver habilitado
  let tagsList = '';
  let availableTags: Tag[] = [];
  if (prompt.canChangeTag) {
    availableTags = await Tag.findAll({ where: { companyId: ticket.companyId } });
    tagsList = availableTags.map(t => `- ${t.name} (ID: ${t.id})`).join('\n');
  }

  // Prompt do sistema otimizado e mais completo (igual ao Gemini)
  const contactName = sanitizeName(contact.name || "Amigo(a)");
  let promptSystem = `Você é um assistente de atendimento. O nome do CLIENTE que você está atendendo é: ${contactName}. Use este nome ao se dirigir ao cliente nas suas respostas.\n${prompt.prompt}\n\nFILAS DISPONÍVEIS PARA TRANSFERÊNCIA:\n${queuesList}\n\nIMPORTANTE: Seja direto e objetivo. Para transferir, use o formato: 'Ação: Transferir para o setor de atendimento [Fila: Nome da Fila]' ou apenas 'Ação: Transferir para o setor de atendimento' para usar a fila padrão. Sua resposta deve usar no máximo ${prompt.maxTokens} tokens e cuide para não truncar o final.`;

  // Adicionar instruções sobre tags se habilitado
  if (prompt.canChangeTag && tagsList) {
    promptSystem += `\n\nTAGS DISPONÍVEIS PARA ALTERAÇÃO:\n${tagsList}\n\nPara alterar a tag/estágio do ticket, use o formato: 'Ação: Alterar tag [Tag: Nome da Tag]'`;
  }

  // Adicionar instruções sobre mensagens internas se habilitado
  if (prompt.canSendInternalMessages) {
    promptSystem += `\n\nANOTAÇÕES INTERNAS: Use [INTERNA]texto[/INTERNA] ANTES ou DEPOIS da resposta ao cliente. Sempre forneça resposta ao cliente.`;
  }

  // Adicionar instruções sobre agendamentos se habilitado
  if (prompt.permitirCriarAgendamentos) {
    promptSystem += `\n\nAGENDAMENTOS: Use [AGENDAR]{"action":"criar|verificar|listar","profissional":"Nome","data":"YYYY-MM-DD","horarioInicio":"HH:mm","horarioFim":"HH:mm"(opcional),"titulo":"Título","descricao":"Desc"(opcional)}[/AGENDAR]. Execute comandos IMEDIATAMENTE sem dizer "vou verificar". Verifique disponibilidade antes de criar. Remova tags [AGENDAR] da resposta final.`;
  }


  let messagesOpenAi: ChatCompletionRequestMessage[] = [];

  if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
    messagesOpenAi = [];
    messagesOpenAi.push({ role: "system", content: promptSystem });

    // Adicionar histórico de mensagens (inverter ordem para ter do mais antigo ao mais recente)
    const sortedMessages = [...messages].reverse();
    for (
      let i = 0;
      i < Math.min(maxHistoryMessages, sortedMessages.length);
      i++
    ) {
      const message = sortedMessages[i];
      if (
        message.mediaType === "conversation" ||
        message.mediaType === "extendedTextMessage"
      ) {
        if (message.fromMe) {
          messagesOpenAi.push({ role: "assistant", content: message.body });
        } else {
          messagesOpenAi.push({ role: "user", content: message.body });
        }
      }
    }

    // Adicionar mensagem atual do usuário
    messagesOpenAi.push({ role: "user", content: bodyMessage! });

    const chat = await openai.createChatCompletion({
      model: prompt.model,
      messages: messagesOpenAi,
      max_tokens: prompt.maxTokens,
      temperature: prompt.temperature
    });

    let response = chat.data.choices[0].message?.content;

    // Detectar e processar mensagens internas
    const internalMessages: string[] = [];
    let cleanedResponse = response || "";

    if (prompt.canSendInternalMessages) {
      // Regex unificado que captura [INTERNA]...[/INTERNA] de forma não-gulosa
      // Usa uma única passagem para evitar duplicação
      const internalMessageRegex = /\[INTERNA\](.*?)\[\/INTERNA\]/gs;
      const processedMatches = new Set<string>(); // Para evitar duplicação

      let match;
      // Processar todas as mensagens internas com fechamento explícito
      while ((match = internalMessageRegex.exec(response || "")) !== null) {
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
    if (prompt.permitirCriarAgendamentos && response) {
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
              allowCreate: prompt.permitirCriarAgendamentos
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
    if (prompt.canChangeTag && response?.includes("Ação: Alterar tag")) {
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
    if (response?.includes("Ação: Transferir para o setor de atendimento")) {
      // Se canTransferToAgent não estiver habilitado, apenas enviar mensagem
      if (!prompt.canTransferToAgent) {
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
        // Determinar fila de destino (usar padrão do Gemini)
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
          targetQueueId = prompt.transferQueueId || prompt.queueId || null;
          const defaultQueue = availableQueues.find(q => q.id === targetQueueId);
          targetQueueName = defaultQueue?.name || null;
          if (targetQueueId) {
            logger.info(`Usando fila padrão configurada: ID ${targetQueueId}`);
          }
        }

        if (targetQueueId) {
          try {
            // Gerar resumo do contexto antes de transferir
            const summary = await generateContextSummary({
              ticketId: ticket.id,
              companyId: ticket.companyId,
              provider: "openai",
              maxMessages: prompt.maxMessages
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
          // NOTA: UpdateTicketService já envia a mensagem automática de transferência, não precisa chamar sendTransferMessage novamente
          await transferQueue(targetQueueId, ticket, contact);
          logger.info(`Ticket ${ticket.id} transferido para fila ${targetQueueId} (${targetQueueName})`);
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
          logger.warn(`Mensagem duplicada detectada (OpenAI), não enviando. Ticket: ${ticket.id}, TimeDiff: ${timeDiff}ms, Conteúdo: ${normalizedResponse.substring(0, 50)}...`);
          // Remover lock antes de retornar
          openAiProcessingLocks.delete(lockKey);
          return;
        }
      }

      const sentMessage = await wbot.sendMessage(msg.key.remoteJid!, {
        text: cleanedResponse
      });
      await verifyMessage(sentMessage!, ticket, contact);
    }

    // Remover lock após processamento bem-sucedido
    openAiProcessingLocks.delete(lockKey);
    logger.debug(`Lock removido (OpenAI): ${lockKey}`);

  } else if (msg.message?.audioMessage) {
    const mediaUrl = mediaSent!.mediaUrl!.split("/").pop();
    const file = fs.createReadStream(`${publicFolder}/${mediaUrl}`) as any;
    const transcription = await openai.createTranscription(file, "whisper-1");

    messagesOpenAi = [];
    messagesOpenAi.push({ role: "system", content: promptSystem });

    // Adicionar histórico de mensagens (inverter ordem para ter do mais antigo ao mais recente)
    const sortedAudioMessages = [...messages].reverse();
    for (let i = 0; i < Math.min(maxHistoryMessages, sortedAudioMessages.length); i++) {
      const message = sortedAudioMessages[i];
      if (
        message.mediaType === "conversation" ||
        message.mediaType === "extendedTextMessage"
      ) {
        if (message.fromMe) {
          messagesOpenAi.push({ role: "assistant", content: message.body });
        } else {
          messagesOpenAi.push({ role: "user", content: message.body });
        }
      }
    }
    messagesOpenAi.push({ role: "user", content: transcription.data.text });

    // Garantir que há tokens suficientes para a resposta
    const maxTokensToUse = Math.max(prompt.maxTokens, 1024);

    const chat = await openai.createChatCompletion({
      model: prompt.model || "gpt-4o-mini", // Fallback se modelo não estiver definido
      messages: messagesOpenAi,
      max_tokens: maxTokensToUse,
      temperature: prompt.temperature
    });
    let response = chat.data.choices[0].message?.content;

    // Aplicar mesma lógica de mensagens internas e transferência para áudio
    let cleanedAudioResponse = response || "";
    const audioInternalMessages: string[] = [];

    if (prompt.canSendInternalMessages && response) {
      // Regex unificado que captura [INTERNA]...[/INTERNA] de forma não-gulosa
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
          audioInternalMessages.push(internalContent);
          // Remover o marcador completo da resposta
          cleanedAudioResponse = cleanedAudioResponse.replace(fullMatch, "").trim();
        }
      }

      // Limpar qualquer [INTERNA] restante sem fechamento
      const openInternalRegex = /\[INTERNA\][^\[]*?(?=\[INTERNA\]|$)/gs;
      while ((match = openInternalRegex.exec(cleanedAudioResponse)) !== null) {
        const fullMatch = match[0];
        const internalContent = match[0].replace(/\[INTERNA\]/g, "").trim();

        if (internalContent && !fullMatch.includes("[/INTERNA]") && !processedMatches.has(fullMatch)) {
          processedMatches.add(fullMatch);
          audioInternalMessages.push(internalContent);
          cleanedAudioResponse = cleanedAudioResponse.replace(fullMatch, "").trim();
        }
      }

      // Limpeza final
      cleanedAudioResponse = cleanedAudioResponse
        .replace(/\[INTERNA\][^\[]*?/g, "")
        .replace(/\[\/INTERNA\]/g, "")
        .replace(/\n\s*\n\s*\n/g, "\n\n")
        .trim();

      // Enviar mensagens internas (apenas uma vez cada)
      const uniqueAudioInternalMessages = [...new Set(audioInternalMessages)];
      for (const internalContent of uniqueAudioInternalMessages) {
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
            logger.info(`✅ Mensagem interna (áudio) enviada: ${internalContent.substring(0, 50)}...`);
          } catch (err: any) {
            logger.error(`❌ Erro ao enviar mensagem interna (áudio): ${err.message}`);
          }
        }
      }
    }

    // Verificar se precisa alterar tag (áudio)
    if (prompt.canChangeTag && response?.includes("Ação: Alterar tag")) {
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
            logger.info(`Tag alterada para "${matchedTag.name}" no ticket ${ticket.id} (áudio)`);
          } catch (err: any) {
            logger.error(`Erro ao alterar tag (áudio): ${err.message}`);
          }
        } else {
          logger.warn(`Tag especificada pela IA não encontrada (áudio): "${specifiedTagName}"`);
        }
      }

      // Remover ação de alteração de tag da resposta
      cleanedAudioResponse = cleanedAudioResponse
        .replace(/Ação: Alterar tag\s*\[Tag:[^\]]+\]/gi, "")
        .replace("Ação: Alterar tag", "")
        .trim();
    }

    if (response?.includes("Ação: Transferir para o setor de atendimento")) {
      // Se canTransferToAgent não estiver habilitado, apenas enviar mensagem
      if (!prompt.canTransferToAgent) {
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

        cleanedAudioResponse = cleanedAudioResponse
          .replace(/Ação: Transferir para o setor de atendimento\s*\[Fila:[^\]]+\]/gi, "")
          .replace("Ação: Transferir para o setor de atendimento", "")
          .trim();
      } else {
        // Determinar fila de destino (usar padrão do Gemini)
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
            logger.info(`IA especificou fila (áudio): "${specifiedQueueName}" -> ID: ${targetQueueId}`);
          } else {
            logger.warn(`Fila especificada pela IA não encontrada (áudio): "${specifiedQueueName}". Usando fila padrão.`);
          }
        }

        // Se não encontrou fila especificada, usar a fila padrão configurada
        if (!targetQueueId) {
          targetQueueId = prompt.transferQueueId || prompt.queueId || null;
          const defaultQueue = availableQueues.find(q => q.id === targetQueueId);
          targetQueueName = defaultQueue?.name || null;
          if (targetQueueId) {
            logger.info(`Usando fila padrão configurada (áudio): ID ${targetQueueId}`);
          }
        }

        if (targetQueueId) {
          try {
            const summary = await generateContextSummary({
              ticketId: ticket.id,
              companyId: ticket.companyId,
              provider: "openai",
              maxMessages: prompt.maxMessages
            });

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
            logger.info(`Resumo do contexto gerado antes da transferência do ticket ${ticket.id} (áudio)`);
          } catch (err: any) {
            logger.error(`Erro ao gerar resumo antes da transferência (áudio): ${err.message}`);
            // Continua com a transferência mesmo se o resumo falhar
          }

          // Transferir para a fila
          // NOTA: UpdateTicketService já envia a mensagem automática de transferência, não precisa chamar sendTransferMessage novamente
          await transferQueue(targetQueueId, ticket, contact);
          logger.info(`Ticket ${ticket.id} transferido para fila ${targetQueueId} (${targetQueueName}) (áudio)`);
        } else {
          logger.error(`Nenhuma fila disponível para transferência do ticket ${ticket.id} (áudio)`);
        }

        // Remover ação e especificação de fila da resposta
        cleanedAudioResponse = cleanedAudioResponse
          .replace(/Ação: Transferir para o setor de atendimento\s*\[Fila:[^\]]+\]/gi, "")
          .replace("Ação: Transferir para o setor de atendimento", "")
          .trim();
      }
    }

    // Validação final para áudio: garantir que nenhum marcador [INTERNA] seja enviado ao cliente
    if (cleanedAudioResponse.includes("[INTERNA]") || cleanedAudioResponse.includes("[/INTERNA]")) {
      logger.error(`⚠️ ATENÇÃO: Marcadores [INTERNA] ainda presentes na resposta de áudio! Removendo...`);
      cleanedAudioResponse = cleanedAudioResponse
        .replace(/\[INTERNA\][^\[]*?/g, "")
        .replace(/\[\/INTERNA\]/g, "")
        .trim();
    }

    // Enviar resposta de áudio (sem mensagens internas)
    if (cleanedAudioResponse.trim()) {
      // Verificar se mensagem duplicada antes de enviar (áudio)
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
        const normalizedResponse = cleanedAudioResponse.trim().toLowerCase().replace(/\u200e/g, "").trim();
        const isIdentical = normalizedRecent === normalizedResponse;
        
        if (isRecent && isIdentical) {
          logger.warn(`Mensagem duplicada detectada (OpenAI - áudio), não enviando. Ticket: ${ticket.id}, TimeDiff: ${timeDiff}ms`);
          // Remover lock antes de retornar
          openAiProcessingLocks.delete(lockKey);
          return;
        }
      }
      const sentMessage = await wbot.sendMessage(msg.key.remoteJid!, {
        text: cleanedAudioResponse
      });
      await verifyMessage(sentMessage!, ticket, contact);
    }
    
    // Remover lock após processamento de áudio
    openAiProcessingLocks.delete(lockKey);
    logger.debug(`Lock removido (OpenAI - áudio): ${lockKey}`);
  }
  
  // Remover lock após processamento completo (caso não tenha sido removido antes)
  if (openAiProcessingLocks.has(lockKey)) {
    openAiProcessingLocks.delete(lockKey);
    logger.debug(`Lock removido (OpenAI - final): ${lockKey}`);
  }
  
  messagesOpenAi = [];
};

export const transferQueue = async (
  queueId: number,
  ticket: Ticket,
  contact: Contact
): Promise<void> => {
  await UpdateTicketService({
    ticketData: { queueId: queueId },
    ticketId: ticket.id,
    companyId: ticket.companyId
  });
};

export const verifyMediaMessage = async (
  msg: proto.IWebMessageInfo,
  ticket: Ticket,
  contact: Contact,
  ticketTraking: TicketTraking = null,
  isForwarded: boolean = false,
  isPrivate: boolean = false,
  wbot: Session = null
): Promise<Message> => {
  const io = getIO();
  const quotedMsg = await verifyQuotedMessage(msg);
  const media = await downloadMedia(msg);

  if (!media) {
    throw new Error("ERR_WAPP_DOWNLOAD_MEDIA");
  }

  if (!media.filename) {
    const ext = mimeExtension(media.mimetype);
    media.filename = `${new Date().getTime()}.${ext}`;
  }

  try {
    // Converter Buffer para Uint8Array se necessário para compatibilidade com tipos
    const dataBuffer = Buffer.isBuffer(media.data)
      ? new Uint8Array(media.data)
      : Buffer.from(media.data as string, 'base64');

    await writeFileAsync(
      join(__dirname, "..", "..", "..", "public", media.filename),
      dataBuffer as any
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error(err);
  }

  const body = getBodyMessage(msg);

  const hasCap = hasCaption(body, media.filename);
  const bodyMessage = body ? hasCap ? formatBody(body, ticket.contact) : "-" : "-";

  // Garantir ACK inicial correto para mensagens de mídia
  let initialAck = msg.status;
  if (initialAck === undefined || initialAck === null) {
    initialAck = msg.key.fromMe ? 1 : 0;
  }
  
  // Para mensagens enviadas em grupos, sempre marcar como enviada (ACK = 1)
  // pois o WhatsApp não retorna confirmações de entrega/visualização para grupos
  if (msg.key.fromMe && ticket.isGroup) {
    initialAck = 1;
    logger.debug('ACK forçado para 1 (enviada) - mensagem de mídia em grupo na criação', {
      messageId: msg.key.id,
      ticketId: ticket.id
    });
  }

  const messageData = {
    id: msg.key.id,
    ticketId: ticket.id,
    contactId: msg.key.fromMe ? undefined : contact.id,
    body: bodyMessage,
    fromMe: msg.key.fromMe,
    read: msg.key.fromMe,
    mediaUrl: media.filename,
    mediaType: media.mimetype.split("/")[0],
    quotedMsgId: quotedMsg?.id,
    ack: initialAck,
    remoteJid: msg.key.remoteJid,
    participant: msg.key.participant,
    dataJson: JSON.stringify(msg),
    ticketTrakingId: ticketTraking?.id,
  };

  logger.debug('💾 Salvando mensagem de mídia:', {
    messageId: messageData.id,
    ticketId: messageData.ticketId,
    fromMe: messageData.fromMe,
    initialAck: messageData.ack,
    mediaType: messageData.mediaType
  });

  await ticket.update({
    lastMessage: body || "Arquivo de mídia"
  });

  let newMessage: Message;
  try {
    newMessage = await CreateMessageService({
      messageData,
      companyId: ticket.companyId
    });
  } catch (error) {
    logger.error({
      msg: "verifyMediaMessage: Falha crítica ao salvar mensagem de mídia no banco",
      messageId: messageData.id,
      ticketId: ticket.id,
      companyId: ticket.companyId,
      error: error?.message || error
    });
    Sentry.captureException(error, {
      tags: {
        service: "verifyMediaMessage",
        messageId: messageData.id,
        ticketId: ticket.id
      }
    });
    // Re-lançar o erro para que o chamador saiba que a mensagem não foi salva
    throw error;
  }

  // Verificar se é uma resposta de avaliação ANTES de reabrir o ticket
  if (!msg.key.fromMe && ticket.status === "rating") {
    // Buscar ticketTraking para verificar se há avaliação pendente
    const ticketTraking = await FindOrCreateATicketTrakingService({
      ticketId: ticket.id,
      companyId: ticket.companyId,
      whatsappId: ticket.whatsappId
    });

    const vr = ticketTraking ? verifyRating(ticketTraking) : false;
    const bodyMessage = body?.trim() || "";
    const ratingMatch = bodyMessage.match(/^[1-3]$/);

    if (ticketTraking && vr) {
      if (ratingMatch) {
        await handleRating(parseFloat(ratingMatch[0]), ticket, ticketTraking);
        return newMessage; // Não reabrir o ticket, apenas processar a avaliação
      }
    }

    // Se não for avaliação, reabrir o ticket normalmente
    await ticket.update({ status: "pending" });
    await ticket.reload({
      include: [
        {
          model: Queue,
          as: "queue",
          include: [
            { model: Prompt, as: "prompt" }
          ]
        },
        { model: User, as: "user" },
        { model: Contact, as: "contact" }
      ]
    });

    io.to(`company-${ticket.companyId}-rating`)
      .to(`queue-${ticket.queueId}-rating`)
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "delete",
        ticket,
        ticketId: ticket.id
      });

    io.to(`company-${ticket.companyId}-${ticket.status}`)
      .to(`queue-${ticket.queueId}-${ticket.status}`)
      .to(ticket.id.toString())
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "update",
        ticket,
        ticketId: ticket.id
      });
  }

  return newMessage;
};

export type VerifyMessageOptions = {
  /** Body original do envio (ex.: do job). Quando fromMe, usar este em vez do echo do WA para o frontend fazer match com a mensagem otimista. */
  originalBody?: string;
};

export const verifyMessage = async (
  msg: proto.IWebMessageInfo,
  ticket: Ticket,
  contact: Contact,
  options?: VerifyMessageOptions
) => {
  const io = getIO();
  // Só buscar mensagem citada quando houver referência (evita query desnecessária)
  const quotedMsg = getQuotedMessageId(msg) ? await verifyQuotedMessage(msg) : null;
  const bodyFromMsg = getBodyMessage(msg);
  // Para mensagens fromMe, preferir body original (ex. do job) para o frontend substituir a otimista corretamente
  const body =
    msg.key.fromMe && options?.originalBody != null && String(options.originalBody).trim() !== ""
      ? options.originalBody
      : bodyFromMsg;
  const isEdited = getTypeMessage(msg) == "editedMessage";

  // Garantir ACK inicial correto
  // Se msg.status for undefined, usar valor padrão baseado em fromMe
  let initialAck = msg.status;
  if (initialAck === undefined || initialAck === null) {
    // fromMe: começa em 1 (pendente/enviando)
    // !fromMe: começa em 0 (recebida)
    initialAck = msg.key.fromMe ? 1 : 0;
  }
  
  // Para mensagens enviadas em grupos, sempre marcar como enviada (ACK = 1)
  // pois o WhatsApp não retorna confirmações de entrega/visualização para grupos
  if (msg.key.fromMe && ticket.isGroup) {
    initialAck = 1;
    logger.debug('ACK forçado para 1 (enviada) - mensagem em grupo na criação', {
      messageId: msg.key.id,
      ticketId: ticket.id
    });
  }

  // Normalizar id para string (Baileys pode retornar Buffer); evita ACK não encontrar a mensagem no banco
  const rawId = isEdited
    ? msg?.message?.editedMessage?.message?.protocolMessage?.key?.id
    : msg.key.id;
  const normalizedId = rawId != null ? String(rawId) : (msg.key?.id != null ? String(msg.key.id) : undefined);
  if (!normalizedId) return;
  const messageData = {
    id: normalizedId,
    ticketId: ticket.id,
    contactId: msg.key.fromMe ? undefined : contact.id,
    body,
    fromMe: msg.key.fromMe,
    mediaType: getTypeMessage(msg),
    read: msg.key.fromMe,
    quotedMsgId: quotedMsg?.id,
    ack: initialAck,
    remoteJid: msg.key.remoteJid,
    participant: msg.key.participant,
    dataJson: JSON.stringify(msg),
    isEdited: isEdited
  };

  logger.debug('💾 Salvando mensagem:', {
    messageId: messageData.id,
    ticketId: messageData.ticketId,
    fromMe: messageData.fromMe,
    initialAck: messageData.ack,
    remoteJid: messageData.remoteJid,
    participant: messageData.participant
  });

  await ticket.update({
    lastMessage: body,
    fromMe: msg.key.fromMe ?? false
  });

  try {
    await CreateMessageService({ messageData, companyId: ticket.companyId });
  } catch (error) {
    logger.error({
      msg: "verifyMessage: Falha crítica ao salvar mensagem no banco",
      messageId: messageData.id,
      ticketId: ticket.id,
      companyId: ticket.companyId,
      error: error?.message || error
    });
    Sentry.captureException(error, {
      tags: {
        service: "verifyMessage",
        messageId: messageData.id,
        ticketId: ticket.id
      }
    });
    // Re-lançar o erro para que o chamador saiba que a mensagem não foi salva
    throw error;
  }

  // Quando o atendente responde (fromMe), emitir atualização do ticket para o frontend
  // atualizar a lista e remover o status "Aguardando resposta"
  if (msg.key.fromMe) {
    await ticket.reload({
      include: [
        { model: Queue, as: "queue", include: [{ model: Prompt, as: "prompt" }] },
        { model: User, as: "user" },
        { model: Contact, as: "contact" }
      ]
    });
    io.to(`company-${ticket.companyId}-${ticket.status}`)
      .to(`queue-${ticket.queueId}-${ticket.status}`)
      .to(ticket.id.toString())
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "update",
        ticket,
        ticketId: ticket.id
      });
  }

  // Verificar se é uma resposta de avaliação ANTES de reabrir o ticket
  if (!msg.key.fromMe && ticket.status === "rating") {
    // Buscar ticketTraking para verificar se há avaliação pendente
    const ticketTraking = await FindOrCreateATicketTrakingService({
      ticketId: ticket.id,
      companyId: ticket.companyId,
      whatsappId: ticket.whatsappId
    });

    // Se for uma resposta de avaliação, processar e não reabrir o ticket
    const vr = ticketTraking ? verifyRating(ticketTraking) : false;
    const bodyMessage = body?.trim() || "";
    const ratingMatch = bodyMessage.match(/^[1-3]$/);

    if (ticketTraking && vr) {
      if (ratingMatch) {
        await handleRating(parseFloat(ratingMatch[0]), ticket, ticketTraking);
        return; // Não reabrir o ticket, apenas processar a avaliação
      }
    }

    // Se não for avaliação, reabrir o ticket normalmente
    await ticket.update({ status: "pending" });
    await ticket.reload({
      include: [
        {
          model: Queue,
          as: "queue",
          include: [
            { model: Prompt, as: "prompt" }
          ]
        },
        { model: User, as: "user" },
        { model: Contact, as: "contact" }
      ]
    });

    io.to(`company-${ticket.companyId}-rating`)
      .to(`queue-${ticket.queueId}-rating`)
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "delete",
        ticket,
        ticketId: ticket.id
      });

    io.to(`company-${ticket.companyId}-${ticket.status}`)
      .to(`queue-${ticket.queueId}-${ticket.status}`)
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "update",
        ticket,
        ticketId: ticket.id
      });
  }
};

const isValidMsg = (msg: proto.IWebMessageInfo): boolean => {
  if (msg.key.remoteJid === "status@broadcast") return false;
  try {
    const msgType = getTypeMessage(msg);
    if (!msgType) {
      // Log para debug quando msgType é null/undefined
      logger.warn(`isValidMsg: msgType é null/undefined para mensagem ${msg.key.id}`);
      return false; // Retorna false explicitamente ao invés de undefined
    }

    const ifType =
      msgType === "conversation" ||
      msgType === "extendedTextMessage" ||
      msgType === "editedMessage" ||
      msgType === "audioMessage" ||
      msgType === "videoMessage" ||
      msgType === "imageMessage" ||
      msgType === "documentMessage" ||
      msgType === "documentWithCaptionMessage" ||
      msgType === "stickerMessage" ||
      msgType === "buttonsResponseMessage" ||
      msgType === "buttonsMessage" ||
      msgType === "messageContextInfo" ||
      msgType === "locationMessage" ||
      msgType === "liveLocationMessage" ||
      msgType === "contactMessage" ||
      msgType === "voiceMessage" ||
      msgType === "mediaMessage" ||
      msgType === "contactsArrayMessage" ||
      msgType === "reactionMessage" ||
      msgType === "ephemeralMessage" ||
      msgType === "protocolMessage" ||
      msgType === "listResponseMessage" ||
      msgType === "listMessage" ||
      msgType === "viewOnceMessage";

    if (!ifType) {
      logger.warn(`#### Nao achou o type em isValidMsg: ${msgType}
${JSON.stringify(msg?.message)}`);
      Sentry.setExtra("Mensagem", { BodyMsg: msg.message, msg, msgType });
      Sentry.captureException(new Error("Novo Tipo de Mensagem em isValidMsg"));
    }

    return !!ifType;
  } catch (error) {
    Sentry.setExtra("Error isValidMsg", { msg });
    Sentry.captureException(error);
  }
};

const Push = (msg: proto.IWebMessageInfo) => {
  return msg.pushName;
};

const verifyQueue = async (
  wbot: Session,
  msg: proto.IWebMessageInfo,
  ticket: Ticket,
  contact: Contact,
  mediaSent?: Message | undefined
) => {

  const companyId = ticket.companyId;

  const { queues, greetingMessage, maxUseBotQueues, timeUseBotQueues } =
    await ShowWhatsAppService(wbot.id!, ticket.companyId);

  if (queues.length === 1) {
    const sendGreetingMessageOneQueues = await Setting.findOne({
      where: {
        key: "sendGreetingMessageOneQueues",
        companyId: ticket.companyId
      }
    });

    if (
      greetingMessage.length > 1 &&
      sendGreetingMessageOneQueues?.value === "enabled"
    ) {
      const body = formatBody(`${greetingMessage}`, contact);

      if (body.trim().replace(/\u200e/g, '').length > 0) {
        // CORREÇÃO: Usar getChatJid para obter o destino correto do chat
        const chatJid = getChatJid(ticket);
        const sentMsg = await wbot.sendMessage(
          chatJid,
          {
            text: body
          }
        );
        if (sentMsg) await verifyMessage(sentMsg, ticket, contact);
      }
    }

    const firstQueue = head(queues);
    let chatbot = false;
    if (firstQueue?.options) {
      chatbot = firstQueue.options.length > 0;
    }

    //inicia integração dialogflow/n8n
    if (
      !msg.key.fromMe &&
      !ticket.isGroup &&
      !isNil(queues[0]?.integrationId)
    ) {
      const integrations = await ShowQueueIntegrationService(
        queues[0].integrationId,
        companyId
      );

      await handleMessageIntegration(
        msg,
        wbot,
        integrations,
        ticket,
        companyId
      );

      await ticket.update({
        useIntegration: true,
        integrationId: integrations.id
      });
      // return;
    }
    //inicia integração openai/gemini
    if (!msg.key.fromMe && !ticket.isGroup && !isNil(queues[0]?.promptId)) {
      // Buscar prompt para verificar provider
      try {
        const prompt = await ShowPromptService({
          promptId: queues[0].promptId,
          companyId: ticket.companyId
        });

        // Debounce: cancelar processamento anterior se nova mensagem chegar muito rapidamente
        const debounceKey = ticket.id;
        if (aiProcessingDebounces.has(debounceKey)) {
          clearTimeout(aiProcessingDebounces.get(debounceKey)!);
          aiProcessingDebounces.delete(debounceKey);
          logger.debug(`Debounce: cancelando processamento anterior para ticket ${ticket.id}`);
        }

        // Agendar processamento com debounce de 500ms
        const processAI = async () => {
          try {
            if (prompt.provider === "gemini") {
              await handleGeminiInListener(msg, wbot, ticket, contact, mediaSent);
            } else {
              await handleOpenAi(msg, wbot, ticket, contact, mediaSent);
            }
            
            await ticket.update({
              useIntegration: true,
              promptId: queues[0]?.promptId
            });
          } finally {
            aiProcessingDebounces.delete(debounceKey);
          }
        };

        const debounceTimeout = setTimeout(processAI, 500);
        aiProcessingDebounces.set(debounceKey, debounceTimeout);
      } catch (err) {
        // Se não encontrar prompt, tentar OpenAI por compatibilidade
        await handleOpenAi(msg, wbot, ticket, contact, mediaSent);
        await ticket.update({
          useIntegration: true,
          promptId: queues[0]?.promptId
        });
      }
      // return;
    }

    await UpdateTicketService({
      ticketData: { queueId: firstQueue.id, chatbot, status: "pending" },
      ticketId: ticket.id,
      companyId: ticket.companyId
    });

    return;
  }

  const selectedOption = getBodyMessage(msg);
  const choosenQueue = queues[+selectedOption - 1];

  const buttonActive = await Setting.findOne({
    where: {
      key: "chatBotType",
      companyId
    }
  });

  const botText = async () => {
    let options = "";

    queues.forEach((queue, index) => {
      options += `*[ ${index + 1} ]* - ${queue.name}\n`;
    });

    const textMessage = {
      text: formatBody(`\u200e${greetingMessage}\n\n${options}`, contact)
    };

    // CORREÇÃO: Usar getChatJid para obter o destino correto do chat
    const chatJid = getChatJid(ticket);
    const sendMsg = await wbot.sendMessage(
      chatJid,
      textMessage
    );

    await verifyMessage(sendMsg, ticket, ticket.contact);
  };

  if (choosenQueue) {
    let chatbot = false;
    if (choosenQueue?.options) {
      chatbot = choosenQueue.options.length > 0;
    }

    await UpdateTicketService({
      ticketData: { queueId: choosenQueue.id, chatbot },
      ticketId: ticket.id,
      companyId: ticket.companyId
    });

    /* Tratamento para envio de mensagem quando a fila está fora do expediente */
    if (choosenQueue.options.length === 0) {
      const queue = await Queue.findByPk(choosenQueue.id);
      const { schedules }: any = queue;
      const now = moment();
      const weekday = now.format("dddd").toLowerCase();
      let schedule;
      if (Array.isArray(schedules) && schedules.length > 0) {
        schedule = schedules.find(
          s =>
            s.weekdayEn === weekday &&
            s.startTime !== "" &&
            s.startTime !== null &&
            s.endTime !== "" &&
            s.endTime !== null
        );
      }

      if (
        queue.outOfHoursMessage !== null &&
        queue.outOfHoursMessage !== "" &&
        !isNil(schedule)
      ) {
        const startTime = moment(schedule.startTime, "HH:mm");
        const endTime = moment(schedule.endTime, "HH:mm");

        if (now.isBefore(startTime) || now.isAfter(endTime)) {
          const body = formatBody(
            `\u200e ${queue.outOfHoursMessage}\n\n*[ # ]* - Voltar ao Menu Principal`,
            ticket.contact
          );

          if (queue.outOfHoursMessage && queue.outOfHoursMessage.trim().length > 0) {
            // CORREÇÃO: Usar getChatJid para obter o destino correto do chat
            const chatJid = getChatJid(ticket);
            const sentMessage = await wbot.sendMessage(
              chatJid,
              {
                text: body
              }
            );
            await verifyMessage(sentMessage, ticket, contact);
          }


          await UpdateTicketService({
            ticketData: { queueId: null, chatbot },
            ticketId: ticket.id,
            companyId: ticket.companyId
          });
          return;
        }
      }

      //inicia integração dialogflow/n8n
      if (!msg.key.fromMe && !ticket.isGroup && choosenQueue.integrationId) {
        const integrations = await ShowQueueIntegrationService(
          choosenQueue.integrationId,
          companyId
        );

        await handleMessageIntegration(
          msg,
          wbot,
          integrations,
          ticket,
          companyId
        );

        await ticket.update({
          useIntegration: true,
          integrationId: integrations.id
        });
        // return;
      }

      //inicia integração openai/gemini
      if (
        !msg.key.fromMe &&
        !ticket.isGroup &&
        !isNil(choosenQueue?.promptId)
      ) {
        // Buscar prompt para verificar provider
        try {
          const prompt = await ShowPromptService({
            promptId: choosenQueue.promptId,
            companyId: ticket.companyId
          });

          // Debounce: cancelar processamento anterior se nova mensagem chegar muito rapidamente
          const debounceKey = ticket.id;
          if (aiProcessingDebounces.has(debounceKey)) {
            clearTimeout(aiProcessingDebounces.get(debounceKey)!);
            aiProcessingDebounces.delete(debounceKey);
            logger.debug(`Debounce: cancelando processamento anterior para ticket ${ticket.id}`);
          }

          // Agendar processamento com debounce de 500ms
          const processAI = async () => {
            try {
              if (prompt.provider === "gemini") {
                await handleGeminiInListener(msg, wbot, ticket, contact, mediaSent);
              } else {
                await handleOpenAi(msg, wbot, ticket, contact, mediaSent);
              }
              
              await ticket.update({
                useIntegration: true,
                promptId: choosenQueue?.promptId
              });
            } finally {
              aiProcessingDebounces.delete(debounceKey);
            }
          };

          const debounceTimeout = setTimeout(processAI, 500);
          aiProcessingDebounces.set(debounceKey, debounceTimeout);
        } catch (err) {
          // Se não encontrar prompt, tentar OpenAI por compatibilidade
          await handleOpenAi(msg, wbot, ticket, contact, mediaSent);
          await ticket.update({
            useIntegration: true,
            promptId: choosenQueue?.promptId
          });
        }
        // return;
      }

      const body = formatBody(
        `\u200e${choosenQueue.greetingMessage}`,
        ticket.contact
      );
      if (choosenQueue.greetingMessage) {
        // CORREÇÃO: Usar getChatJid para obter o destino correto do chat
        const chatJid = getChatJid(ticket);
        const sentMessage = await wbot.sendMessage(
          chatJid,
          {
            text: body
          }
        );
        await verifyMessage(sentMessage, ticket, contact);
      }
    }
  } else {
    if (
      maxUseBotQueues &&
      maxUseBotQueues !== 0 &&
      ticket.amountUsedBotQueues >= maxUseBotQueues
    ) {
      // await UpdateTicketService({
      //   ticketData: { queueId: queues[0].id },
      //   ticketId: ticket.id
      // });

      return;
    }

    //Regra para desabilitar o chatbot por x minutos/horas após o primeiro envio
    const ticketTraking = await FindOrCreateATicketTrakingService({
      ticketId: ticket.id,
      companyId
    });
    let dataLimite = new Date();
    let Agora = new Date();

    if (ticketTraking.chatbotAt !== null) {
      dataLimite.setMinutes(
        ticketTraking.chatbotAt.getMinutes() + Number(timeUseBotQueues)
      );

      if (
        ticketTraking.chatbotAt !== null &&
        Agora < dataLimite &&
        timeUseBotQueues !== "0" &&
        ticket.amountUsedBotQueues !== 0
      ) {
        return;
      }
    }
    await ticketTraking.update({
      chatbotAt: null
    });

    if (buttonActive.value === "text") {
      return botText();
    }
  }
};

export const verifyRating = (ticketTraking: TicketTraking) => {
  if (
    ticketTraking &&
    ticketTraking.finishedAt === null &&
    ticketTraking.userId !== null &&
    ticketTraking.ratingAt !== null
  ) {
    return true;
  }
  return false;
};

export const handleRating = async (
  rate: number,
  ticket: Ticket,
  ticketTraking: TicketTraking
) => {
  // Validação defensiva: abortar se rate não for um número inteiro válido.
  // NaN, undefined, Infinity e floats sem parte inteira chegam aqui quando
  // o usuário manda texto livre (ex: "ok", "⭐", string vazia).
  const rateInt = Math.round(rate);
  if (!Number.isFinite(rate) || isNaN(rateInt)) {
    logger.warn({
      msg: "handleRating: valor de avaliação inválido recebido. Abortando sem salvar.",
      rawRate: rate,
      ticketId: ticket.id,
      companyId: ticket.companyId
    });
    return;
  }

  const io = getIO();

  const { complationMessage } = await ShowWhatsAppService(
    ticket.whatsappId,
    ticket.companyId
  );

  // Clamp entre 1 e 3
  const finalRate = Math.min(3, Math.max(1, rateInt));

  // Guarda valores antes de atualizar o ticket (queueId vira null no update)
  const companyId = ticket.companyId;
  const queueId = ticket.queueId;

  await UserRating.create({
    ticketId: ticketTraking.ticketId,
    companyId: ticketTraking.companyId,
    userId: ticketTraking.userId,
    rate: finalRate
  });

  await ticketTraking.update({
    finishedAt: moment().toDate(),
    rated: true
  });

  await ticket.update({
    queueId: null,
    chatbot: null,
    queueOptionId: null,
    userId: null,
    status: "closed"
  });

  io.to(`company-${companyId}-open`)
    .to(`queue-${queueId}-open`)
    .emit(`company-${ticket.companyId}-ticket`, {
      action: "delete",
      ticket,
      ticketId: ticket.id
    });

  io.to(`company-${companyId}-${ticket.status}`)
    .to(`queue-${queueId}-${ticket.status}`)
    .to(ticket.id.toString())
    .emit(`company-${ticket.companyId}-ticket`, {
      action: "update",
      ticket,
      ticketId: ticket.id
    });

  // Enviar mensagem de conclusão do WhatsApp pode falhar (ex: conexão fechada).
  // Nao podemos deixar essa falha impedir a persistencia da avaliacao no banco.
  if (complationMessage) {
    try {
      const body = formatBody(`‎${complationMessage}`, ticket.contact);
      await SendWhatsAppMessage({ body, ticket });
    } catch (err) {
      logger.warn({
        msg: "handleRating: falha ao enviar mensagem de conclusão",
        ticketId: ticket.id,
        companyId,
        whatsappId: ticket.whatsappId,
        error: err?.message || err
      });
    }
  }
};

const handleChartbot = async (
  ticket: Ticket,
  msg: WAMessage,
  wbot: Session,
  dontReadTheFirstQuestion: boolean = false
) => {
  const queue = await Queue.findByPk(ticket.queueId, {
    include: [
      {
        model: QueueOption,
        as: "options",
        where: { parentId: null },
        order: [
          ["option", "ASC"],
          ["createdAt", "ASC"]
        ]
      }
    ]
  });

  const messageBody = getBodyMessage(msg);

  if (messageBody == "#") {
    // voltar para o menu inicial
    await ticket.update({ queueOptionId: null, chatbot: false, queueId: null });
    await verifyQueue(wbot, msg, ticket, ticket.contact);
    return;
  }

  // voltar para o menu anterior
  if (!isNil(queue) && !isNil(ticket.queueOptionId) && messageBody == "0") {
    const option = await QueueOption.findByPk(ticket.queueOptionId);
    await ticket.update({ queueOptionId: option?.parentId });

    // escolheu uma opção
  } else if (!isNil(queue) && !isNil(ticket.queueOptionId)) {
    const count = await QueueOption.count({
      where: { parentId: ticket.queueOptionId }
    });
    let option: any = {};
    if (count == 1) {
      option = await QueueOption.findOne({
        where: { parentId: ticket.queueOptionId }
      });
    } else {
      option = await QueueOption.findOne({
        where: {
          option: messageBody || "",
          parentId: ticket.queueOptionId
        }
      });
    }
    if (option) {
      await ticket.update({ queueOptionId: option?.id });
    }

    // não linha a primeira pergunta
  } else if (
    !isNil(queue) &&
    isNil(ticket.queueOptionId) &&
    !dontReadTheFirstQuestion
  ) {
    const option = queue?.options.find(o => o.option == messageBody);
    if (option) {
      await ticket.update({ queueOptionId: option?.id });
    }
  }

  await ticket.reload();

  if (!isNil(queue) && isNil(ticket.queueOptionId)) {
    const queueOptions = await QueueOption.findAll({
      where: { queueId: ticket.queueId, parentId: null },
      order: [
        ["option", "ASC"],
        ["createdAt", "ASC"]
      ]
    });

    const companyId = ticket.companyId;

    const buttonActive = await Setting.findOne({
      where: {
        key: "chatBotType",
        companyId
      }
    });

    // const botList = async () => {
    // const sectionsRows = [];

    // queues.forEach((queue, index) => {
    //   sectionsRows.push({
    //     title: queue.name,
    //     rowId: `${index + 1}`
    //   });
    // });

    // const sections = [
    //   {
    //     rows: sectionsRows
    //   }
    // ];

    //   const listMessage = {
    //     text: formatBody(`\u200e${queue.greetingMessage}`, ticket.contact),
    //     buttonText: "Escolha uma opção",
    //     sections
    //   };

    //   const sendMsg = await wbot.sendMessage(
    //     `${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
    //     listMessage
    //   );

    //   await verifyMessage(sendMsg, ticket, ticket.contact);
    // }

    const botButton = async () => {
      const buttons = [];
      queueOptions.forEach((option, i) => {
        buttons.push({
          buttonId: `${option.option}`,
          buttonText: { displayText: option.title },
          type: 4
        });
      });
      buttons.push({
        buttonId: `#`,
        buttonText: { displayText: "Menu inicial *[ 0 ]* Menu anterior" },
        type: 4
      });

      const buttonMessage = {
        text: formatBody(`\u200e${queue.greetingMessage}`, ticket.contact),
        buttons,
        headerType: 4
      };

      // Usar getChatJid para obter destino correto
      const chatJid = getChatJid(ticket);
      const sendMsg = await wbot.sendMessage(
        chatJid,
        buttonMessage
      );

      await verifyMessage(sendMsg, ticket, ticket.contact);
    };

    const botText = async () => {
      let options = "";

      queueOptions.forEach((option, i) => {
        options += `*[ ${option.option} ]* - ${option.title}\n`;
      });
      //options += `\n*[ 0 ]* - Menu anterior`;
      options += `\n*[ # ]* - Menu inicial`;

      const textMessage = {
        text: formatBody(
          `\u200e${queue.greetingMessage}\n\n${options}`,
          ticket.contact
        )
      };

      // Usar getChatJid para obter destino correto
      const chatJid = getChatJid(ticket);
      const sendMsg = await wbot.sendMessage(
        chatJid,
        textMessage
      );

      await verifyMessage(sendMsg, ticket, ticket.contact);
    };

    // if (buttonActive.value === "list") {
    //   return botList();
    // };

    if (buttonActive.value === "button" && QueueOption.length <= 4) {
      return botButton();
    }

    if (buttonActive.value === "text") {
      return botText();
    }

    if (buttonActive.value === "button" && QueueOption.length > 4) {
      return botText();
    }
  } else if (!isNil(queue) && !isNil(ticket.queueOptionId)) {
    const currentOption = await QueueOption.findByPk(ticket.queueOptionId);
    const queueOptions = await QueueOption.findAll({
      where: { parentId: ticket.queueOptionId },
      order: [
        ["option", "ASC"],
        ["createdAt", "ASC"]
      ]
    });

    if (queueOptions.length > -1) {
      const companyId = ticket.companyId;
      const buttonActive = await Setting.findOne({
        where: {
          key: "chatBotType",
          companyId
        }
      });

      const botList = async () => {
        const sectionsRows = [];

        queueOptions.forEach((option, i) => {
          sectionsRows.push({
            title: option.title,
            rowId: `${option.option}`
          });
        });
        sectionsRows.push({
          title: "Menu inicial *[ 0 ]* Menu anterior",
          rowId: `#`
        });
        const sections = [
          {
            rows: sectionsRows
          }
        ];

        const listMessage = {
          text: formatBody(`\u200e${currentOption.message}`, ticket.contact),
          buttonText: "Escolha uma opção",
          sections
        };

        // Usar getChatJid para obter destino correto
        const chatJid = getChatJid(ticket);
        const sendMsg = await wbot.sendMessage(
          chatJid,
          listMessage
        );

        await verifyMessage(sendMsg, ticket, ticket.contact);
      };

      const botButton = async () => {
        const buttons = [];
        queueOptions.forEach((option, i) => {
          buttons.push({
            buttonId: `${option.option}`,
            buttonText: { displayText: option.title },
            type: 4
          });
        });
        buttons.push({
          buttonId: `#`,
          buttonText: { displayText: "Menu inicial *[ 0 ]* Menu anterior" },
          type: 4
        });

        const buttonMessage = {
          text: formatBody(`\u200e${currentOption.message}`, ticket.contact),
          buttons,
          headerType: 4
        };

        // Usar getChatJid para obter destino correto
        const chatJid = getChatJid(ticket);
        const sendMsg = await wbot.sendMessage(
          chatJid,
          buttonMessage
        );

        await verifyMessage(sendMsg, ticket, ticket.contact);
      };

      const botText = async () => {
        let options = "";

        queueOptions.forEach((option, i) => {
          options += `*[ ${option.option} ]* - ${option.title}\n`;
        });
        options += `\n*[ 0 ]* - Menu anterior`;
        options += `\n*[ # ]* - Menu inicial`;
        const textMessage = {
          text: formatBody(
            `\u200e${currentOption.message}\n\n${options}`,
            ticket.contact
          )
        };

        // Usar getChatJid para obter destino correto
        const chatJid = getChatJid(ticket);
        const sendMsg = await wbot.sendMessage(
          chatJid,
          textMessage
        );

        await verifyMessage(sendMsg, ticket, ticket.contact);
      };

      if (buttonActive.value === "list") {
        return botList();
      }

      if (buttonActive.value === "button" && QueueOption.length <= 4) {
        return botButton();
      }

      if (buttonActive.value === "text") {
        return botText();
      }

      if (buttonActive.value === "button" && QueueOption.length > 4) {
        return botText();
      }
    }
  }
};

const flowbuilderIntegration = async (
  msg: proto.IWebMessageInfo,
  wbot: Session,
  companyId: number,
  queueIntegration: QueueIntegrations,
  ticket: Ticket,
  contact: Contact,
  isFirstMsg?: Ticket,
  isTranfered?: boolean
) => {
  const io = getIO();
  const quotedMsg = await verifyQuotedMessage(msg);
  const body = getBodyMessage(msg);

  // 🔍 LOG DETALHADO - INÍCIO
  logger.info('🌊 === FLOWBUILDER INTEGRATION START ===', {
    ticketId: ticket.id,
    contactId: contact.id,
    contactNumber: contact.number,
    whatsappId: wbot.id,
    integrationId: queueIntegration.id,
    integrationName: queueIntegration.name,
    isFirstMsg: !!isFirstMsg,
    isTranfered: !!isTranfered,
    messageBody: body,
    fromMe: msg.key.fromMe,
    ticketStatus: ticket.status,
    ticketUseIntegration: ticket.useIntegration
  });

  // Buscar WhatsApp para verificar flowIdWelcome e flowIdNotPhrase
  const whatsappFlow = await Whatsapp.findByPk(wbot.id);
  logger.info('🔍 Configuração WhatsApp FlowBuilder:', {
    whatsappId: wbot.id,
    flowIdWelcome: whatsappFlow?.flowIdWelcome,
    flowIdNotPhrase: whatsappFlow?.flowIdNotPhrase,
    hasFlowWelcome: !!whatsappFlow?.flowIdWelcome,
    hasFlowNotPhrase: !!whatsappFlow?.flowIdNotPhrase
  });

  /*
  const messageData = {
    wid: msg.key.id,
    ticketId: ticket.id,
    contactId: msg.key.fromMe ? undefined : contact.id,
    body: body,
    fromMe: msg.key.fromMe,
    read: msg.key.fromMe,
    quotedMsgId: quotedMsg?.id,
    ack: Number(String(msg.status).replace('PENDING', '2').replace('NaN', '1')) || 2,
    remoteJid: msg.key.remoteJid,
    participant: msg.key.participant,
    dataJson: JSON.stringify(msg),
    createdAt: new Date(
      Math.floor(getTimestampMessage(msg.messageTimestamp) * 1000)
    ).toISOString(),
    ticketImported: ticket.imported,
  };


  await CreateMessageService({ messageData, companyId: ticket.companyId });

  */

  if (!msg.key.fromMe && ticket.status === "rating") {
    const ticketTraking = await FindOrCreateATicketTrakingService({
      ticketId: ticket.id,
      companyId,
      whatsappId: ticket.whatsappId
    });

    if (ticketTraking && verifyRating(ticketTraking)) {
      const bodyMessage = body?.trim() || "";
      const ratingMatch = bodyMessage.match(/^[1-3]$/);
      if (ratingMatch) {
        await handleRating(parseInt(ratingMatch[0], 10), ticket, ticketTraking);
        return;
      }
    }

    await UpdateTicketService({
      ticketData: { status: "pending", integrationId: ticket.integrationId },
      ticketId: ticket.id,
      companyId
    });
    return;
  }

  if (msg.key.fromMe) {
    return;
  }

  const whatsapp = await ShowWhatsAppService(wbot.id!, companyId);

  const listPhrase = await FlowCampaignModel.findAll({
    where: {
      whatsappId: whatsapp.id
    }
  });

  // Welcome flow
  if (
    !isFirstMsg &&
    listPhrase.filter(item => item.phrase.toLowerCase() === body.toLowerCase()).length === 0
  ) {
    const flow = await FlowBuilderModel.findOne({
      where: {
        id: whatsapp.flowIdWelcome
      }
    });
    if (flow) {
      const nodes: INodes[] = flow.flow["nodes"];
      const connections: IConnections[] = flow.flow["connections"];

      const mountDataContact = {
        number: contact.number,
        name: contact.name,
        email: contact.email
      };

      // const worker = new Worker("./src/services/WebhookService/WorkerAction.ts");

      // // Enviar as variáveis como parte da mensagem para o Worker
      // console.log('DISPARO1')
      // const data = {
      //   idFlowDb: flowUse.flowIdWelcome,
      //   companyId: ticketUpdate.companyId,
      //   nodes: nodes,
      //   connects: connections,
      //   nextStage: flow.flow["nodes"][0].id,
      //   dataWebhook: null,
      //   details: "",
      //   hashWebhookId: "",
      //   pressKey: null,
      //   idTicket: ticketUpdate.id,
      //   numberPhrase: mountDataContact
      // };
      // worker.postMessage(data);
      // worker.on("message", message => {
      //   console.log(`Mensagem do worker: ${message}`);
      // });

      await ActionsWebhookService(
        whatsapp.id,
        whatsapp.flowIdWelcome,
        ticket.companyId,
        nodes,
        connections,
        flow.flow["nodes"][0].id,
        null,
        "",
        "",
        null,
        ticket.id,
        mountDataContact,
        msg
      );
    }
  }

  const dateTicket = new Date(
    isFirstMsg?.updatedAt ? isFirstMsg.updatedAt : ""
  );

  const dateNow = new Date();
  const diferencaEmMilissegundos = Math.abs(
    differenceInMilliseconds(dateTicket, dateNow)
  );
  //const seisHorasEmMilissegundos = 21600000;
  const seisHorasEmMilissegundos = 0;

  logger.info(listPhrase.filter(item => item.phrase.toLowerCase()));
  logger.info(isFirstMsg);

  // Flow with not found phrase
  if (
    listPhrase.filter(item => item.phrase.toLowerCase() === body.toLowerCase()).length === 0 &&
    diferencaEmMilissegundos >= seisHorasEmMilissegundos &&
    isFirstMsg
  ) {
    console.log("2427", "handleMessageIntegration");

    const flow = await FlowBuilderModel.findOne({
      where: {
        id: whatsapp.flowIdNotPhrase
      }
    });

    if (flow) {
      const nodes: INodes[] = flow.flow["nodes"];
      const connections: IConnections[] = flow.flow["connections"];

      const mountDataContact = {
        number: contact.number,
        name: contact.name,
        email: contact.email
      };

      await ActionsWebhookService(
        whatsapp.id,
        whatsapp.flowIdNotPhrase,
        ticket.companyId,
        nodes,
        connections,
        flow.flow["nodes"][0].id,
        null,
        "",
        "",
        null,
        ticket.id,
        mountDataContact,
        msg
      );
    }
  }

  // Campaign fluxo
  if (listPhrase.filter(item => item.phrase.toLowerCase() === body.toLowerCase()).length !== 0) {

    const flowDispar = listPhrase.filter(item => item.phrase.toLowerCase() === body.toLowerCase())[0];
    const flow = await FlowBuilderModel.findOne({
      where: {
        id: flowDispar.flowId
      }
    });
    const nodes: INodes[] = flow.flow["nodes"];
    const connections: IConnections[] = flow.flow["connections"];

    const mountDataContact = {
      number: contact.number,
      name: contact.name,
      email: contact.email
    };

    //const worker = new Worker("./src/services/WebhookService/WorkerAction.ts");

    //console.log('DISPARO3')
    // Enviar as variáveis como parte da mensagem para o Worker
    // const data = {
    //   idFlowDb: flowDispar.flowId,
    //   companyId: ticketUpdate.companyId,
    //   nodes: nodes,
    //   connects: connections,
    //   nextStage: flow.flow["nodes"][0].id,
    //   dataWebhook: null,
    //   details: "",
    //   hashWebhookId: "",
    //   pressKey: null,
    //   idTicket: ticketUpdate.id,
    //   numberPhrase: mountDataContact
    // };
    // worker.postMessage(data);

    // worker.on("message", message => {
    //   console.log(`Mensagem do worker: ${message}`);
    // });

    await ActionsWebhookService(
      whatsapp.id,
      flowDispar.flowId,
      ticket.companyId,
      nodes,
      connections,
      flow.flow["nodes"][0].id,
      null,
      "",
      "",
      null,
      ticket.id,
      mountDataContact
    );
    return;
  }

  if (ticket.flowWebhook) {
    const webhook = await WebhookModel.findOne({
      where: {
        company_id: ticket.companyId,
        hash_id: ticket.hashFlowId
      }
    });

    if (webhook && webhook.config["details"]) {
      const flow = await FlowBuilderModel.findOne({
        where: {
          id: webhook.config["details"].idFlow
        }
      });
      const nodes: INodes[] = flow.flow["nodes"];
      const connections: IConnections[] = flow.flow["connections"];

      // const worker = new Worker("./src/services/WebhookService/WorkerAction.ts");

      // console.log('DISPARO4')
      // // Enviar as variáveis como parte da mensagem para o Worker
      // const data = {
      //   idFlowDb: webhook.config["details"].idFlow,
      //   companyId: ticketUpdate.companyId,
      //   nodes: nodes,
      //   connects: connections,
      //   nextStage: ticketUpdate.lastFlowId,
      //   dataWebhook: ticketUpdate.dataWebhook,
      //   details: webhook.config["details"],
      //   hashWebhookId: ticketUpdate.hashFlowId,
      //   pressKey: body,
      //   idTicket: ticketUpdate.id,
      //   numberPhrase: ""
      // };
      // worker.postMessage(data);

      // worker.on("message", message => {
      //   console.log(`Mensagem do worker: ${message}`);
      // });

      await ActionsWebhookService(
        whatsapp.id,
        webhook.config["details"].idFlow,
        ticket.companyId,
        nodes,
        connections,
        ticket.lastFlowId,
        ticket.dataWebhook,
        webhook.config["details"],
        ticket.hashFlowId,
        body,
        ticket.id
      );
    } else {
      const flow = await FlowBuilderModel.findOne({
        where: {
          id: ticket.flowStopped
        }
      });

      const nodes: INodes[] = flow.flow["nodes"];
      const connections: IConnections[] = flow.flow["connections"];

      if (!ticket.lastFlowId) {
        return;
      }

      const mountDataContact = {
        number: contact.number,
        name: contact.name,
        email: contact.email
      };

      // const worker = new Worker("./src/services/WebhookService/WorkerAction.ts");

      // console.log('DISPARO5')
      // // Enviar as variáveis como parte da mensagem para o Worker
      // const data = {
      //   idFlowDb: parseInt(ticketUpdate.flowStopped),
      //   companyId: ticketUpdate.companyId,
      //   nodes: nodes,
      //   connects: connections,
      //   nextStage: ticketUpdate.lastFlowId,
      //   dataWebhook: null,
      //   details: "",
      //   hashWebhookId: "",
      //   pressKey: body,
      //   idTicket: ticketUpdate.id,
      //   numberPhrase: mountDataContact
      // };
      // worker.postMessage(data);
      // worker.on("message", message => {
      //   console.log(`Mensagem do worker: ${message}`);
      // });

      await ActionsWebhookService(
        whatsapp.id,
        parseInt(ticket.flowStopped),
        ticket.companyId,
        nodes,
        connections,
        ticket.lastFlowId,
        null,
        "",
        "",
        body,
        ticket.id,
        mountDataContact,
        msg
      );
    }
  }
};

export const handleMessageIntegration = async (
  msg: proto.IWebMessageInfo,
  wbot: Session,
  queueIntegration: QueueIntegrations,
  ticket: Ticket,
  companyId: number,
  isMenu: boolean = null,
  whatsapp: Whatsapp = null,
  contact: Contact = null,
  isFirstMsg: Ticket | null = null,
): Promise<void> => {
  const msgType = getTypeMessage(msg);

  logger.info('🔗 === HANDLE MESSAGE INTEGRATION ===', {
    integrationType: queueIntegration.type,
    integrationId: queueIntegration.id,
    integrationName: queueIntegration.name,
    isMenu,
    ticketId: ticket.id,
    msgType
  });

  if (queueIntegration.type === "n8n" || queueIntegration.type === "webhook") {
    logger.info('📡 Processando integração N8N/Webhook');
    if (queueIntegration?.urlN8N) {
      const options = {
        method: "POST",
        url: queueIntegration?.urlN8N,
        headers: {
          "Content-Type": "application/json"
        },
        json: msg
      };
      try {
        request(options, function (error, response) {
          if (error) {
            throw new Error(error);
          } else {
            console.log(response.body);
          }
        });
      } catch (error) {
        throw new Error(error);
      }
    }
  } else if (queueIntegration.type === "typebot") {
    logger.info('🤖 Processando integração Typebot');
    // await typebots(ticket, msg, wbot, queueIntegration);
    await typebotListener({ ticket, msg, wbot, typebot: queueIntegration });
  } else if (queueIntegration.type === "flowbuilder") {
    logger.info('🌊 Processando integração FlowBuilder', {
      isMenu,
      ticketLastMessage: ticket.lastMessage,
      ticketStatus: ticket.status
    });

    if (!isMenu) {
      logger.info('✅ FlowBuilder: Modo DIRETO (não é menu)');
      await flowbuilderIntegration(
        msg,
        wbot,
        companyId,
        queueIntegration,
        ticket,
        contact,
        isFirstMsg
      );
    } else {
      logger.info('📋 FlowBuilder: Modo MENU', {
        lastMessageIsNumber: !isNaN(parseInt(ticket.lastMessage)),
        ticketStatus: ticket.status
      });

      if (
        !isNaN(parseInt(ticket.lastMessage)) &&
        ticket.status !== "open" &&
        ticket.status !== "closed"
      ) {
        logger.info('✅ Chamando flowBuilderQueue');
        await flowBuilderQueue(
          ticket,
          msg,
          wbot,
          whatsapp,
          companyId,
          contact,
          isFirstMsg
        );
      } else {
        logger.debug('FlowBuilderQueue não chamado - condições não atendidas');
      }
    }
  } else {
    logger.warn('⚠️ Tipo de integração desconhecido:', queueIntegration.type);
  }
};

const flowBuilderQueue = async (
  ticket: Ticket,
  msg: proto.IWebMessageInfo,
  wbot: Session,
  whatsapp: Whatsapp,
  companyId: number,
  contact: Contact,
  isFirstMsg: Ticket
) => {
  const body = getBodyMessage(msg);

  const flow = await FlowBuilderModel.findOne({
    where: {
      id: ticket.flowStopped
    }
  });

  const mountDataContact = {
    number: contact.number,
    name: contact.name,
    email: contact.email
  };

  const nodes: INodes[] = flow.flow["nodes"];
  const connections: IConnections[] = flow.flow["connections"];

  if (!ticket.lastFlowId) {
    return;
  }

  if (
    ticket.status === "closed" ||
    ticket.status === "rating" ||
    ticket.status === "interrupted" ||
    ticket.status === "open"
  ) {
    return;
  }

  await ActionsWebhookService(
    whatsapp.id,
    parseInt(ticket.flowStopped),
    ticket.companyId,
    nodes,
    connections,
    ticket.lastFlowId,
    null,
    "",
    "",
    body,
    ticket.id,
    mountDataContact,
    msg
  );

  //const integrations = await ShowQueueIntegrationService(whatsapp.integrationId, companyId);
  //await handleMessageIntegration(msg, wbot, integrations, ticket, companyId, true, whatsapp);
};


const handleMessage = async (
  msg: proto.IWebMessageInfo,
  wbot: Session,
  companyId: number
): Promise<void> => {
  let mediaSent: Message | undefined;

  if (!isValidMsg(msg)) {
    logger.debug(`Mensagem rejeitada por isValidMsg: ${msg.key.id} (remoteJid: ${msg.key.remoteJid}, empresa: ${companyId})`);
    return;
  }

  try {
    // ========================================================================
    // EXTRAÇÃO PADRONIZADA DE IDENTIFICADORES
    // ========================================================================
    // chatId: ONDE a conversa está (grupo, privado, broadcast)
    // senderId: QUEM enviou a mensagem (participant em grupos, remoteJid em privado)
    // ========================================================================
    const {
      chatId,      // Onde responder (remoteJid)
      senderId,    // Quem enviou (participant ?? remoteJid)
      isGroup,     // É grupo?
      isBroadcast, // É broadcast/status?
      isFromMe     // Foi enviada por mim?
    } = extractMessageContext(msg);

    // Log de debug com identificadores claros
    logger.debug(`📨 Processando mensagem: chatId=${chatId}, senderId=${senderId}, isGroup=${isGroup}, fromMe=${isFromMe}, empresa=${companyId}`);

    let msgContact: IMe;
    let groupContact: Contact | undefined;

    const msgIsGroupBlock = await Setting.findOne({
      where: {
        companyId,
        key: "CheckMsgIsGroup"
      }
    });

    const bodyMessage = getBodyMessage(msg);
    const msgType = getTypeMessage(msg);

    const hasMedia =
      msg.message?.audioMessage ||
      msg.message?.imageMessage ||
      msg.message?.videoMessage ||
      msg.message?.documentMessage ||
      msg.message?.documentWithCaptionMessage ||
      msg.message.stickerMessage;

    // Obter dados do contato (REMETENTE em grupos, CONTATO em privado)
    msgContact = await getContactMessage(msg, wbot);

    // VALIDAÇÃO DE NÚMEROS BRASILEIROS DESABILITADA - Estava bloqueando mensagens legítimas
    // Se necessário reativar, verificar a lógica de validação para não bloquear números válidos
    // if (!msg.key.fromMe && !isGroup) {
    //   const contactNumber = msgContact.id.replace(/\D/g, "");
    //   
    //   if (!isBrazilianNumber(contactNumber)) {
    //     const countryCode = getCountryCode(contactNumber);
    //     
    //     // Log detalhado do bloqueio
    //     logger.warn(formatBlockedNumberLog(contactNumber, countryCode));
    //     logger.info(`Mensagem bloqueada: número inválido ou não-brasileiro (+${countryCode || "sem código"}) - ${contactNumber} (empresa: ${companyId})`);
    //     
    //     // Log adicional para números muito longos (possíveis números estranhos)
    //     if (contactNumber.length > 13) {
    //       logger.warn(`Número bloqueado por ser muito longo (${contactNumber.length} dígitos): ${contactNumber} - Possível número estranho sem código de país`);
    //     }
    //     
    //     return; // Bloqueia o processamento da mensagem
    //   }
    // }

    if (msgIsGroupBlock?.value === "enabled" && isGroup) return;

    // Em grupos, criar contato separado para o GRUPO (usado para vincular ticket)
    if (isGroup) {
      // Usar chatId (remoteJid) para obter metadados do grupo
      const grupoMeta = await wbot.groupMetadata(chatId);
      const msgGroupContact = {
        id: grupoMeta.id,
        name: grupoMeta.subject,
        // Em Baileys 7.x, owner pode ser LID, ownerPn é o número de telefone
        owner: grupoMeta.ownerPn || grupoMeta.owner,
        descOwner: grupoMeta.descOwnerPn || grupoMeta.descOwner
      };
      groupContact = await verifyContact(msgGroupContact, wbot, companyId);
    }

    const whatsapp = await ShowWhatsAppService(wbot.id!, companyId);

    // contact = contato do REMETENTE (quem enviou a mensagem)
    // Em grupos: é o membro que enviou
    // Em privado: é o contato da conversa
    const contact = await verifyContact(msgContact, wbot, companyId);

    let unreadMessages = 0;

    if (isFromMe) {
      await cacheLayer.set(`contacts:${contact.id}:unreads`, "0");
    } else {
      const unreads = await cacheLayer.get(`contacts:${contact.id}:unreads`);
      unreadMessages = +unreads + 1;
      await cacheLayer.set(
        `contacts:${contact.id}:unreads`,
        `${unreadMessages}`
      );
    }

    const lastMessage = await Message.findOne({
      where: {
        contactId: contact.id,
        companyId
      },
      order: [["createdAt", "DESC"]]
    });

    // Validação de mensagem de conclusão duplicada - adicionado log e verificação mais segura
    // IMPORTANTE: Não bloquear se houver prompt configurado (bot de IA pode precisar responder)
    const hasPromptInWhatsapp = !isNil(whatsapp.promptId);
    if (
      !hasPromptInWhatsapp && // Só bloquear se NÃO houver prompt configurado no WhatsApp
      unreadMessages === 0 &&
      whatsapp.complationMessage &&
      lastMessage &&
      formatBody(whatsapp.complationMessage, contact).trim().toLowerCase() ===
      lastMessage.body.trim().toLowerCase()
    ) {
      logger.info(`Mensagem de conclusão duplicada ignorada para contato ${contact.id} (empresa: ${companyId})`);
      return;
    }

    const ticket = await FindOrCreateTicketService(
      contact,
      wbot.id!,
      unreadMessages,
      companyId,
      groupContact
    );

    await provider(ticket, msg, companyId, contact, wbot as WASocket);

    // voltar para o menu inicial

    if (bodyMessage == "#") {
      await ticket.update({
        queueOptionId: null,
        chatbot: false,
        queueId: null
      });
      await verifyQueue(wbot, msg, ticket, ticket.contact);
      return;
    }

    const ticketTraking = await FindOrCreateATicketTrakingService({
      ticketId: ticket.id,
      companyId,
      whatsappId: whatsapp?.id
    });

    try {
      if (!isFromMe) {
        if (ticketTraking !== null && verifyRating(ticketTraking)) {
          // Validar que a mensagem é um número inteiro antes de processar avaliação
          const ratingMatch = bodyMessage?.trim().match(/^[1-3]$/);
          if (ratingMatch) {
            await handleRating(parseInt(ratingMatch[0], 10), ticket, ticketTraking);
          }
          return;
        }
      }
    } catch (e) {
      Sentry.captureException(e);
      console.log(e);
    }

    // Atualiza o ticket se a ultima mensagem foi enviada por mim, para que possa ser finalizado.
    try {
      await ticket.update({
        fromMe: isFromMe
      });
    } catch (e) {
      Sentry.captureException(e);
      console.log(e);
    }

    if (hasMedia) {
      mediaSent = await verifyMediaMessage(msg, ticket, contact);
    } else {
      await verifyMessage(msg, ticket, contact);
    }

    const currentSchedule = await VerifyCurrentSchedule(companyId);
    const scheduleType = await Setting.findOne({
      where: {
        companyId,
        key: "scheduleType"
      }
    });

    try {
      if (!isFromMe && scheduleType) {
        /**
         * Tratamento para envio de mensagem quando a empresa está fora do expediente
         * IMPORTANTE: Não bloquear se houver prompt configurado (bot de IA pode precisar responder)
         */
        const hasPrompt = !isNil(whatsapp.promptId) || !isNil(ticket?.promptId);
        if (
          !hasPrompt && // Só bloquear se NÃO houver prompt configurado
          scheduleType.value === "company" &&
          !isNil(currentSchedule) &&
          (!currentSchedule || currentSchedule.inActivity === false)
        ) {
          const body = `\u200e ${whatsapp.outOfHoursMessage}`;

          const debouncedSentMessage = debounce(
            async () => {
              // Verifica se a mensagem de fora de horário existe e não está vazia (ignorando caracteres invisíveis)
              if (whatsapp.outOfHoursMessage && whatsapp.outOfHoursMessage.trim().length > 0) {
                // Usar getChatJid para obter destino correto
                const chatJid = getChatJid(ticket);
                const sentMsg = await wbot.sendMessage(
                  chatJid,
                  {
                    text: body
                  }
                );
                if (sentMsg) await verifyMessage(sentMsg, ticket, contact);
              }
            },
            3000,
            ticket.id
          );
          debouncedSentMessage();
          return;
        }

        if (scheduleType.value === "queue" && ticket.queueId !== null) {
          /**
           * Tratamento para envio de mensagem quando a fila está fora do expediente
           */
          const queue = await Queue.findByPk(ticket.queueId);

          const { schedules }: any = queue;
          const now = moment();
          const weekday = now.format("dddd").toLowerCase();
          let schedule = null;

          if (Array.isArray(schedules) && schedules.length > 0) {
            schedule = schedules.find(
              s =>
                s.weekdayEn === weekday &&
                s.startTime !== "" &&
                s.startTime !== null &&
                s.endTime !== "" &&
                s.endTime !== null
            );
          }

          // IMPORTANTE: Não bloquear se houver prompt configurado (bot de IA pode precisar responder)
          const hasPrompt = !isNil(whatsapp.promptId) || !isNil(ticket?.promptId) || !isNil(queue?.promptId);
          if (
            !hasPrompt && // Só bloquear se NÃO houver prompt configurado
            scheduleType.value === "queue" &&
            queue.outOfHoursMessage !== null &&
            queue.outOfHoursMessage !== "" &&
            !isNil(schedule)
          ) {
            const startTime = moment(schedule.startTime, "HH:mm");
            const endTime = moment(schedule.endTime, "HH:mm");

            if (now.isBefore(startTime) || now.isAfter(endTime)) {
              const body = `${queue.outOfHoursMessage}`;
              const debouncedSentMessage = debounce(
                async () => {
                  if (queue.outOfHoursMessage && queue.outOfHoursMessage.trim().length > 0) {
                    // Usar getChatJid para obter destino correto
                    const chatJid = getChatJid(ticket);
                    const sentMsg = await wbot.sendMessage(
                      chatJid,
                      {
                        text: body
                      }
                    );
                    if (sentMsg) await verifyMessage(sentMsg, ticket, contact);
                  }
                },
                3000,
                ticket.id
              );
              debouncedSentMessage();
              return;
            }
          }
        }
      }
    } catch (e) {
      Sentry.captureException(e);
      console.log(e);
    }

    const flow = await FlowBuilderModel.findOne({
      where: {
        id: ticket.flowStopped
      }
    });

    let isMenu = false;
    let isOpenai = false;
    let isQuestion = false;

    if (flow) {
      isMenu =
        flow.flow["nodes"].find((node: any) => node.id === ticket.lastFlowId)
          ?.type === "menu";
      isOpenai =
        flow.flow["nodes"].find((node: any) => node.id === ticket.lastFlowId)
          ?.type === "openai";
      isQuestion =
        flow.flow["nodes"].find((node: any) => node.id === ticket.lastFlowId)
          ?.type === "question";
    }

    if (!isNil(flow) && isQuestion && !isFromMe) {
      console.log(
        "|============= QUESTION =============|",
        JSON.stringify(flow, null, 4)
      );
      const body = getBodyMessage(msg);
      if (body) {
        const nodes: INodes[] = flow.flow["nodes"];
        const nodeSelected = flow.flow["nodes"].find(
          (node: any) => node.id === ticket.lastFlowId
        );

        const connections: IConnections[] = flow.flow["connections"];

        const { message, answerKey } = nodeSelected.data.typebotIntegration;
        const oldDataWebhook = ticket.dataWebhook;

        const nodeIndex = nodes.findIndex(node => node.id === nodeSelected.id);

        const lastFlowId = nodes[nodeIndex + 1].id;
        await ticket.update({
          lastFlowId: lastFlowId,
          dataWebhook: {
            variables: {
              [answerKey]: body
            }
          }
        });

        await ticket.save();

        const mountDataContact = {
          number: contact.number,
          name: contact.name,
          email: contact.email
        };

        await ActionsWebhookService(
          whatsapp.id,
          parseInt(ticket.flowStopped),
          ticket.companyId,
          nodes,
          connections,
          lastFlowId,
          null,
          "",
          "",
          "",
          ticket.id,
          mountDataContact,
          msg
        );
      }

      return;
    }

    if (isOpenai && !isNil(flow) && !ticket.queue) {
      const nodeSelected = flow.flow["nodes"].find(
        (node: any) => node.id === ticket.lastFlowId
      );
      let {
        name,
        prompt,
        voice,
        voiceKey,
        voiceRegion,
        maxTokens,
        temperature,
        apiKey,
        queueId,
        maxMessages,
        provider
      } = nodeSelected.data.typebotIntegration as IOpenAi & { provider?: string };

      // Verificar provider (default: openai para compatibilidade)
      if (provider === "gemini") {
        let geminiSettings = {
          name,
          prompt,
          voice: voice || "texto",
          voiceKey: voiceKey || "",
          voiceRegion: voiceRegion || "",
          maxTokens: parseInt(maxTokens),
          temperature: parseInt(temperature),
          queueId: parseInt(queueId),
          maxMessages: parseInt(maxMessages)
        };

        // Debounce: cancelar processamento anterior se nova mensagem chegar muito rapidamente
        const debounceKey = ticket.id;
        if (aiProcessingDebounces.has(debounceKey)) {
          clearTimeout(aiProcessingDebounces.get(debounceKey)!);
          aiProcessingDebounces.delete(debounceKey);
          logger.debug(`Debounce: cancelando processamento anterior para ticket ${ticket.id}`);
        }

        // Agendar processamento com debounce de 500ms
        const processAI = async () => {
          try {
            await handleGeminiInListener(
              msg,
              wbot,
              ticket,
              contact,
              mediaSent,
              ticketTraking,
              geminiSettings,
            );
          } finally {
            aiProcessingDebounces.delete(debounceKey);
          }
        };

        const debounceTimeout = setTimeout(processAI, 500);
        aiProcessingDebounces.set(debounceKey, debounceTimeout);
      } else {
        let openAiSettings = {
          name,
          prompt,
          voice,
          voiceKey,
          voiceRegion,
          maxTokens: parseInt(maxTokens),
          temperature: parseInt(temperature),
          apiKey,
          queueId: parseInt(queueId),
          maxMessages: parseInt(maxMessages)
        };

        await handleOpenAi(
          msg,
          wbot,
          ticket,
          contact,
          mediaSent,
          ticketTraking,
          openAiSettings,
        );
      }

      return;
    }

    //openai/gemini na conexao
    if (
      !ticket.queue &&
      !isGroup &&
      !isFromMe &&
      !ticket.userId &&
      !isNil(whatsapp.promptId)
    ) {
      // Buscar prompt para verificar provider
      try {
        const prompt = await ShowPromptService({
          promptId: whatsapp.promptId,
          companyId: ticket.companyId
        });

        logger.info(`🤖 Bot de IA detectado - Ticket: ${ticket.id}, Prompt: ${prompt.name}, Provider: ${prompt.provider}`);

        // Debounce: cancelar processamento anterior se nova mensagem chegar muito rapidamente
        const debounceKey = ticket.id;
        if (aiProcessingDebounces.has(debounceKey)) {
          clearTimeout(aiProcessingDebounces.get(debounceKey)!);
          aiProcessingDebounces.delete(debounceKey);
          logger.debug(`Debounce: cancelando processamento anterior para ticket ${ticket.id}`);
        }

        // Agendar processamento com debounce de 500ms
        const processAI = async () => {
          try {
            if (prompt.provider === "gemini") {
              await handleGeminiInListener(msg, wbot, ticket, contact, mediaSent);
            } else {
              // OpenAI ou qualquer outro provider (default para OpenAI)
              await handleOpenAi(msg, wbot, ticket, contact, mediaSent);
            }
          } finally {
            aiProcessingDebounces.delete(debounceKey);
          }
        };

        const debounceTimeout = setTimeout(processAI, 500);
        aiProcessingDebounces.set(debounceKey, debounceTimeout);
      } catch (err: any) {
        logger.error(`Erro ao buscar/iniciar prompt: ${err.message}`, {
          promptId: whatsapp.promptId,
          ticketId: ticket.id,
          companyId: ticket.companyId,
          error: err
        });
        // Se não encontrar prompt, tentar OpenAI por compatibilidade
        try {
          await handleOpenAi(msg, wbot, ticket, contact, mediaSent);
        } catch (openAiErr: any) {
          logger.error(`Erro ao iniciar OpenAI como fallback: ${openAiErr.message}`);
        }
      }
    }

    //integraçao na conexao
    if (
      !isFromMe &&
      !ticket.isGroup &&
      !ticket.queue &&
      !ticket.user &&
      ticket.chatbot &&
      !isNil(whatsapp.integrationId) &&
      !ticket.useIntegration
    ) {

      const integrations = await ShowQueueIntegrationService(
        whatsapp.integrationId,
        companyId
      );

      await handleMessageIntegration(
        msg,
        wbot,
        integrations,
        ticket,
        companyId,
        isMenu
      );

      // ✅ Marcar ticket como usando integração para evitar reexecução
      await ticket.update({
        useIntegration: true,
        integrationId: integrations.id
      });

      return;
    }

    //openai/gemini na fila ou conexão
    // HIERARQUIA: 1. Fila, 2. Conexão/WhatsApp
    // Garantir que a fila está carregada
    let queueWithPrompt = ticket.queue;
    if (!queueWithPrompt && ticket.queueId) {
      const queue = await Queue.findByPk(ticket.queueId, {
        include: [{ model: Prompt, as: "prompt" }]
      });
      queueWithPrompt = queue;
    }
    
    // Buscar prompt da conexão/WhatsApp
    let whatsappPromptId = null;
    try {
      const whatsappData = await ShowWhatsAppService(wbot.id, ticket.companyId);
      whatsappPromptId = whatsappData.promptId;
    } catch (err) {
      // Ignorar erro
    }
    
    // Prioridade: 1. Fila (se ticket tem fila), 2. Ticket, 3. Conexão
    // Se o ticket tem uma fila com prompt, usar o prompt da fila (prioridade)
    const promptIdToUse = (ticket.queueId && queueWithPrompt?.promptId) 
      ? queueWithPrompt.promptId 
      : (ticket.promptId || whatsappPromptId);
    
    if (
      !isGroup &&
      !isFromMe &&
      !ticket.userId &&
      !isNil(promptIdToUse) &&
      (ticket.queueId || whatsappPromptId) // Pode ter prompt mesmo sem fila (prompt da conexão)
    ) {
      // Se o ticket não tem promptId mas a fila ou conexão tem, atualizar o ticket
      // OU se a fila tem um prompt diferente do ticket, atualizar o ticket
      if (
        (!ticket.promptId && (queueWithPrompt?.promptId || whatsappPromptId)) ||
        (ticket.queueId && queueWithPrompt?.promptId && ticket.promptId !== queueWithPrompt.promptId)
      ) {
        const promptIdToAssign = queueWithPrompt?.promptId || whatsappPromptId;
        await ticket.update({
          promptId: promptIdToAssign,
          useIntegration: true
        });
        const source = queueWithPrompt?.promptId ? `fila ${ticket.queueId}` : "conexão WhatsApp";
        logger.info(`Prompt da ${source} aplicado ao ticket ${ticket.id}`);
      }

      // Buscar prompt para verificar provider
      try {
        const prompt = await ShowPromptService({
          promptId: promptIdToUse,
          companyId: ticket.companyId
        });

        if (prompt.provider === "gemini") {
          await handleGeminiInListener(msg, wbot, ticket, contact, mediaSent);
        } else {
          await handleOpenAi(msg, wbot, ticket, contact, mediaSent);
        }
      } catch (err) {
        // Se não encontrar prompt, tentar OpenAI por compatibilidade
        await handleOpenAi(msg, wbot, ticket, contact, mediaSent);
      }
    }

    if (
      !isFromMe &&
      !ticket.isGroup &&
      !ticket.userId &&
      ticket.integrationId &&
      ticket.useIntegration &&
      ticket.queue
    ) {
      console.log("entrou no type 1974");
      const integrations = await ShowQueueIntegrationService(
        ticket.integrationId,
        companyId
      );

      const isFirstMsg = await Ticket.findOne({
        where: {
          contactId: groupContact ? groupContact.id : contact.id,
          companyId,
          whatsappId: whatsapp.id
        },
        order: [["id", "DESC"]]
      });

      await handleMessageIntegration(
        msg,
        wbot,
        integrations,
        ticket,
        companyId,
        isMenu,
        whatsapp,
        contact,
        isFirstMsg
      );
    }

    if (
      !ticket.queue &&
      !ticket.isGroup &&
      !isFromMe &&
      !ticket.userId &&
      whatsapp.queues.length >= 1 &&
      !ticket.useIntegration
    ) {
      await verifyQueue(wbot, msg, ticket, contact);

      if (ticketTraking && ticketTraking.chatbotAt === null) {
        await ticketTraking.update({
          chatbotAt: moment().toDate()
        });
      }
    }

    const isFirstMsg = await Ticket.findOne({
      where: {
        contactId: groupContact ? groupContact.id : contact.id,
        companyId,
        whatsappId: whatsapp.id
      },
      order: [["id", "DESC"]]
    });

    // integração flowbuilder
    const checkFlowBuilder = {
      isFromMe: isFromMe,
      isGroup: ticket.isGroup,
      hasQueue: !!ticket.queue,
      hasUser: !!ticket.user,
      hasIntegrationId: !isNil(whatsapp.integrationId),
      integrationId: whatsapp.integrationId,
      useIntegration: ticket.useIntegration
    };

    logger.debug('VERIFICACAO FLOWBUILDER', checkFlowBuilder);

    if (
      !isFromMe &&
      !ticket.isGroup &&
      !ticket.queue &&
      !ticket.user &&
      !isNil(whatsapp.integrationId) &&
      !ticket.useIntegration
    ) {
      logger.info('✅ Condições atendidas! Buscando integração...', {
        integrationId: whatsapp.integrationId,
        companyId
      });

      const integrations = await ShowQueueIntegrationService(
        whatsapp.integrationId,
        companyId
      );

      logger.info('📋 Integração encontrada:', {
        integrationId: integrations.id,
        integrationType: integrations.type,
        integrationName: integrations.name
      });

      await handleMessageIntegration(
        msg,
        wbot,
        integrations,
        ticket,
        companyId,
        isMenu,
        whatsapp,
        contact,
        isFirstMsg
      );

      // ✅ Marcar ticket como usando integração para evitar reexecução
      await ticket.update({
        useIntegration: true,
        integrationId: integrations.id
      });

      logger.info('✅ FlowBuilder executado! Ticket marcado como useIntegration: true', {
        ticketId: ticket.id,
        integrationId: integrations.id
      });
    } else {
      logger.debug('FlowBuilder NAO foi acionado. Motivos:', {
        bloqueadoPor: {
          isFromMe: isFromMe ? '❌ Mensagem enviada por mim' : '✅',
          isGroup: ticket.isGroup ? '❌ É grupo' : '✅',
          hasQueue: ticket.queue ? '❌ Já tem fila' : '✅',
          hasUser: ticket.user ? '❌ Já tem usuário' : '✅',
          noIntegrationId: isNil(whatsapp.integrationId) ? '❌ WhatsApp sem integrationId' : '✅',
          useIntegration: ticket.useIntegration ? '❌ Ticket já usando integração' : '✅'
        },
        integrationId: whatsapp.integrationId,
        ticketId: ticket.id
      });
    }

    const dontReadTheFirstQuestion = ticket.queue === null;

    await ticket.reload();

    try {
      //Fluxo fora do expediente
      if (!isFromMe && scheduleType && ticket.queueId !== null) {
        /**
         * Tratamento para envio de mensagem quando a fila está fora do expediente
         */
        const queue = await Queue.findByPk(ticket.queueId);

        const { schedules }: any = queue;
        const now = moment();
        const weekday = now.format("dddd").toLowerCase();
        let schedule = null;

        if (Array.isArray(schedules) && schedules.length > 0) {
          schedule = schedules.find(
            s =>
              s.weekdayEn === weekday &&
              s.startTime !== "" &&
              s.startTime !== null &&
              s.endTime !== "" &&
              s.endTime !== null
          );
        }

        if (
          scheduleType.value === "queue" &&
          queue.outOfHoursMessage !== null &&
          queue.outOfHoursMessage !== "" &&
          !isNil(schedule)
        ) {
          const startTime = moment(schedule.startTime, "HH:mm");
          const endTime = moment(schedule.endTime, "HH:mm");

          if (now.isBefore(startTime) || now.isAfter(endTime)) {
            const body = queue.outOfHoursMessage;
            const debouncedSentMessage = debounce(
              async () => {
                // Usar getChatJid para obter destino correto
                const chatJid = getChatJid(ticket);
                const sentMsg = await wbot.sendMessage(
                  chatJid,
                  {
                    text: body
                  }
                );
                if (sentMsg) await verifyMessage(sentMsg, ticket, contact);
              },
              3000,
              ticket.id
            );
            debouncedSentMessage();
            return;
          }
        }
      }
    } catch (e) {
      Sentry.captureException(e);
      console.log(e);
    }

    if (
      !whatsapp?.queues?.length &&
      !ticket.userId &&
      !isGroup &&
      !isFromMe
    ) {
      const lastMessage = await Message.findOne({
        where: {
          ticketId: ticket.id,
          fromMe: true
        },
        order: [["createdAt", "DESC"]]
      });

      const renderedGreetingMessage = formatBody(`${whatsapp.greetingMessage || ""}`, contact);

      if (
        renderedGreetingMessage &&
        lastMessage &&
        lastMessage.body.includes(renderedGreetingMessage)
      ) {
        return;
      }

      if (whatsapp.greetingMessage) {
        const debouncedSentMessage = debounce(
          async () => {
            // Usar getChatJid para obter destino correto
            const chatJid = getChatJid(ticket);
            const greetingBody = formatBody(`${whatsapp.greetingMessage}`, contact);
            if (!greetingBody.trim().replace(/\u200e/g, "").length) {
              return;
            }
            const sentMsg = await wbot.sendMessage(
              chatJid,
              {
                text: greetingBody
              }
            );
            if (sentMsg) await verifyMessage(sentMsg, ticket, contact);
          },
          1000,
          ticket.id
        );
        debouncedSentMessage();
        return;
      }
    }

    if (whatsapp.queues.length == 1 && ticket.queue) {
      if (ticket.chatbot && !isFromMe && msg.key) {
        await handleChartbot(ticket, msg as WAMessage, wbot);
      }
    }

    if (whatsapp.queues.length > 1 && ticket.queue) {
      if (ticket.chatbot && !isFromMe && msg.key) {
        await handleChartbot(ticket, msg as WAMessage, wbot, dontReadTheFirstQuestion);
      }
    }

  } catch (err) {
    console.log(err);
    Sentry.captureException(err);
    logger.error(`Error handling whatsapp message: Err: ${err}`);
  }
};

const handleMsgAck = async (
  msg: WAMessage,
  chat: number | null | undefined
) => {
  const io = getIO();
  const messageId = msg?.key?.id != null ? String(msg.key.id) : "";
  if (!messageId) return;

  try {
    // Busca leve primeiro: só ack para evitar update/emit desnecessários
    const existing = await Message.findByPk(messageId, { attributes: ["id", "ack"] });
    if (existing && existing.ack === chat) {
      return;
    }
    if (!existing) {
      const where: any = { id: messageId };
      if (msg.key.remoteJid) where.remoteJid = msg.key.remoteJid;
      if (msg.key.participant) where.participant = msg.key.participant;
      const alt = await Message.findOne({ where, attributes: ["id", "ack"] });
      if (!alt) {
        logger.debug('Mensagem não encontrada para ACK', { messageId });
        return;
      }
      if (alt.ack === chat) return;
    }

    let messageToUpdate = await Message.findByPk(messageId, {
      include: [
        "contact",
        { model: Message, as: "quotedMsg", include: ["contact"] }
      ]
    });
    if (!messageToUpdate) {
      const where: any = { id: messageId };
      if (msg.key.remoteJid) where.remoteJid = msg.key.remoteJid;
      if (msg.key.participant) where.participant = msg.key.participant;
      messageToUpdate = await Message.findOne({
        where,
        include: [
          "contact",
          { model: Message, as: "quotedMsg", include: ["contact"] }
        ]
      });
    }
    if (!messageToUpdate) return;

    // Para mensagens em grupos, sempre marcar como enviada (ACK = 1)
    // pois o WhatsApp não retorna confirmações de entrega/visualização para grupos
    let ackToSet = chat;
    if (messageToUpdate.fromMe) {
      const ticket = await Ticket.findByPk(messageToUpdate.ticketId, {
        attributes: ["id", "isGroup"]
      });
      if (ticket && ticket.isGroup) {
        // Forçar ACK = 1 (enviada) para grupos
        ackToSet = 1;
        logger.debug('ACK forçado para 1 (enviada) - mensagem em grupo', {
          messageId: messageToUpdate.id,
          ticketId: messageToUpdate.ticketId
        });
      }
    }

    if (messageToUpdate.ack === ackToSet) return;

    await messageToUpdate.update({ ack: ackToSet });
    await messageToUpdate.reload({
      include: [
        "contact",
        { model: Message, as: "quotedMsg", include: ["contact"] }
      ]
    });

    logger.debug('ACK atualizado', { messageId: messageToUpdate.id, ticketId: messageToUpdate.ticketId, ack: chat });

    // Emitir evento para o frontend (reload garante ticketId/companyId/ack corretos)
    io.to(messageToUpdate.ticketId.toString()).emit(
      `company-${messageToUpdate.companyId}-appMessage`,
      {
        action: "update",
        message: messageToUpdate
      }
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error(`❌ Error handling message ack. Err: ${err}`);
  }
};

const verifyCampaignMessageAndCloseTicket = async (
  message: proto.IWebMessageInfo,
  companyId: number
) => {
  const io = getIO();
  const body = getBodyMessage(message);
  const isCampaign = /\u200c/.test(body);
  if (message.key.fromMe && isCampaign) {
    const messageRecord = await Message.findOne({
      where: { id: message.key.id!, companyId }
    });
    const ticket = await Ticket.findByPk(messageRecord.ticketId);
    await ticket.update({ status: "closed" });

    io.to(`company-${ticket.companyId}-open`)
      .to(`queue-${ticket.queueId}-open`)
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "delete",
        ticket,
        ticketId: ticket.id
      });

    io.to(`company-${ticket.companyId}-${ticket.status}`)
      .to(`queue-${ticket.queueId}-${ticket.status}`)
      .to(ticket.id.toString())
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "update",
        ticket,
        ticketId: ticket.id
      });
  }
};

const filterMessages = (msg: WAMessage): boolean => {
  if (msg.message?.protocolMessage) return false;

  if (
    [
      WAMessageStubType.REVOKE,
      WAMessageStubType.E2E_DEVICE_CHANGED,
      WAMessageStubType.E2E_IDENTITY_CHANGED,
      WAMessageStubType.CIPHERTEXT
    ].includes(msg.messageStubType)
  )
    return false;

  return true;
};

const wbotMessageListener = async (
  wbot: Session,
  companyId: number
): Promise<void> => {
  try {
    wbot.ev.on("messages.upsert", async (messageUpsert: ImessageUpsert) => {
      const messages = messageUpsert.messages
        .filter(filterMessages)
        .map(msg => msg);

      if (!messages || messages.length === 0) {
        logger.debug(`Nenhuma mensagem para processar após filtro (empresa: ${companyId})`);
        return;
      }

      logger.debug(`Processando ${messages.length} mensagem(ns) (empresa: ${companyId})`);

      for (const message of messages) {
        try {
          const messageId = message.key.id != null ? String(message.key.id) : "";
          
          if (!messageId) {
            logger.warn({
              msg: "wbotMessageListener: Mensagem sem ID ignorada",
              remoteJid: message.key.remoteJid,
              fromMe: message.key.fromMe,
              companyId
            });
            continue;
          }

          // Verificação de duplicatas melhorada: usar findOne ao invés de count
          // para evitar race conditions e ter mais informações
          const existingMessage = await Message.findOne({
            where: { id: messageId, companyId },
            attributes: ["id", "createdAt"]
          });

          if (!existingMessage) {
            logger.debug({
              msg: "wbotMessageListener: Processando nova mensagem",
              messageId,
              companyId,
              remoteJid: message.key.remoteJid
            });
            
            await handleMessage(message, wbot, companyId);
            await verifyCampaignMessageAndCloseTicket(message, companyId);
          } else {
            logger.debug({
              msg: "wbotMessageListener: Mensagem duplicada ignorada",
              messageId,
              companyId,
              existingCreatedAt: existingMessage.createdAt
            });
          }
        } catch (error) {
          logger.error({
            msg: "wbotMessageListener: Erro crítico ao processar mensagem",
            messageId: message.key.id,
            remoteJid: message.key.remoteJid,
            fromMe: message.key.fromMe,
            companyId,
            error: error?.message || error,
            stack: error?.stack
          });
          Sentry.captureException(error, {
            tags: {
              service: "wbotMessageListener",
              messageId: message.key.id,
              companyId
            },
            extra: {
              remoteJid: message.key.remoteJid,
              fromMe: message.key.fromMe
            }
          });
          // NÃO re-lançar o erro aqui — continuar processando outras mensagens do batch
          // O erro já foi logado e enviado ao Sentry para investigação
        }
      }
    });

    // Debounce ACK updates para evitar centenas de DB/socket por segundo
    const pendingAckByKey = new Map<string, { key: WAMessageUpdate["key"]; status: number }>();
    let ackFlushTimer: NodeJS.Timeout | null = null;
    const flushAckUpdates = () => {
      ackFlushTimer = null;
      if (pendingAckByKey.size === 0) return;
      const entries = Array.from(pendingAckByKey.entries());
      pendingAckByKey.clear();
      const keys = entries.map(([, v]) => v.key);
      try {
        (wbot as WASocket)!.readMessages(keys);
      } catch (_) {}
      entries.forEach(([, v]) => {
        handleMsgAck({ key: v.key } as WAMessage, v.status).catch(() => {});
      });
    };

    wbot.ev.on("messages.update", (messageUpdate: WAMessageUpdate[]) => {
      if (messageUpdate.length === 0) return;

      messageUpdate.forEach((message: WAMessageUpdate) => {
        const id = message.key.id;
        if (!id) return;
        pendingAckByKey.set(id, { key: message.key, status: message.update.status });
      });

      const debounceMs = 800;
      if (ackFlushTimer) clearTimeout(ackFlushTimer);
      ackFlushTimer = setTimeout(flushAckUpdates, debounceMs);
    });

    // Handler para atualizações de mapeamento LID/PN (Baileys 7.x).
    // Decisão atual: o mapeamento NÃO é persistido em banco (sem tabela LidMapping/campo Contact.lid).
    // Apenas logamos e, quando aplicável, contatos existentes são logados; a resolução LID→PN em
    // verifyContact usa getPNForLID do wbot (mapeamento em memória do Baileys). Se no futuro for
    // necessário persistir, adicionar migration + persistência aqui e usar na resolução de contato.
    // O evento pode receber um objeto único { lid, pn } ou um objeto com múltiplos mapeamentos.
    wbot.ev.on("lid-mapping.update", async (mapping: any) => {
      try {
        // O evento pode ter diferentes formatos dependendo da versão do Baileys
        // Tentar tratar ambos os formatos possíveis
        let mappings: Array<{ lid: string; pn: string; jid?: string }> = [];

        if (mapping.lid && mapping.pn) {
          // Formato: { lid: string, pn: string }
          mappings = [{ lid: mapping.lid, pn: mapping.pn }];
        } else if (typeof mapping === 'object' && !mapping.lid) {
          // Formato: { [jid: string]: { lid?: string, phoneNumber?: string } }
          mappings = Object.entries(mapping).map(([jid, value]: [string, any]) => ({
            lid: value.lid || jid,
            pn: value.phoneNumber || value.pn || jid,
            jid
          }));
        } else {
          mappings = [mapping];
        }

        logger.info(`LID mapping atualizado: ${mappings.length} mapeamento(s) (empresa: ${companyId})`);

        // Atualizar contatos existentes com novos mapeamentos LID/PN
        for (const map of mappings) {
          try {
            const phoneNumber = map.pn?.replace(/@.*$/, "").replace(/\D/g, "") || "";

            if (phoneNumber) {
              // Buscar contato pelo número
              const contact = await Contact.findOne({
                where: {
                  number: phoneNumber,
                  companyId
                }
              });

              if (contact) {
                // Atualizar contato com informações de LID se necessário
                // Nota: Pode ser necessário adicionar campo 'lid' ao modelo Contact no futuro
                logger.debug(`Mapeamento LID/PN atualizado para contato ${contact.id}: LID=${map.lid}, PN=${map.pn}`);
              } else {
                logger.debug(`Contato não encontrado para número ${phoneNumber} ao processar LID mapping`);
              }
            }
          } catch (error) {
            logger.error(`Erro ao processar mapeamento LID/PN: ${error}`);
            Sentry.captureException(error);
          }
        }
      } catch (error) {
        logger.error(`Erro ao processar lid-mapping.update: ${error}`);
        Sentry.captureException(error);
      }
    });

    // wbot.ev.on("messages.set", async (messageSet: IMessage) => {
    //   messageSet.messages.filter(filterMessages).map(msg => msg);
    // });
  } catch (error) {
    Sentry.captureException(error);
    logger.error(`Error handling wbot message listener. Err: ${error}`);
  }
};

export { wbotMessageListener, handleMessage };
