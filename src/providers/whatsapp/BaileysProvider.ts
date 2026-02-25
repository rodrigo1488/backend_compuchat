import { WAMessage, MiscMessageGenerationOptions } from "baileys";
import * as Sentry from "@sentry/node";
import AppError from "../../errors/AppError";
import GetWhatsappWbot from "../../helpers/GetWhatsappWbot";
import Whatsapp from "../../models/Whatsapp";
import {
  IWhatsAppProvider,
  SendMessageOptions,
  SendMediaOptions
} from "./IWhatsAppProvider";
import fs from "fs";
import { getMessageOptions } from "../../services/WbotServices/SendWhatsAppMedia";

class BaileysProvider implements IWhatsAppProvider {
  // Serializa envios por sessão para evitar concorrência no estado Signal
  private readonly sendLocks = new Map<number, Promise<unknown>>();

  private enqueueSend<T>(whatsappId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.sendLocks.get(whatsappId) ?? Promise.resolve();

    const current = previous
      .catch(() => undefined)
      .then(task);

    this.sendLocks.set(whatsappId, current);

    current.finally(() => {
      if (this.sendLocks.get(whatsappId) === current) {
        this.sendLocks.delete(whatsappId);
      }
    });

    return current;
  }

  /**
   * Constrói o JID correto para envio de mensagens.
   * CORREÇÃO: Detecta se é grupo baseado no formato do número
   * - Se já contém @g.us ou @s.whatsapp.net, usa como está
   * - Se termina com padrão de grupo (números-números@g.us), usa @g.us
   * - Caso contrário, usa @s.whatsapp.net (chat privado)
   */
  private buildChatJid(number: string): string {
    // Se já é um JID completo, retorna como está
    if (number.includes("@")) {
      return number;
    }
    
    // Detecta se é um grupo pelo padrão (grupos geralmente têm formato: numerosrandom-timestamp)
    // Grupos têm formato como: 120363123456789012@g.us
    // Para simplificar, se o número limpo tiver mais de 15 dígitos, provavelmente é um grupo
    const cleanNumber = number.replace(/\D/g, "");
    
    // Grupos geralmente têm IDs maiores que números de telefone
    // Números de telefone raramente passam de 15 dígitos
    if (cleanNumber.length > 15) {
      return `${number}@g.us`;
    }
    
    return `${number}@s.whatsapp.net`;
  }

  async sendMessage(
    whatsapp: Whatsapp,
    number: string,
    body: string,
    options?: SendMessageOptions
  ): Promise<WAMessage> {
    try {
      return this.enqueueSend(whatsapp.id, async () => {
        const wbot = await GetWhatsappWbot(whatsapp);
        // CORREÇÃO: Usar buildChatJid para suportar grupos corretamente
        const chatId = this.buildChatJid(number);
        const formattedBody = `\u200e${body}`;

        // Converter opções para o formato esperado pelo Baileys
        const baileysOptions = options as MiscMessageGenerationOptions & { contextInfo?: { mentionedJid?: string[] } };

        // Baileys espera "mentions" no nível raiz do conteúdo (não contextInfo) - processa e injeta em contextInfo
        const messageContent: any = { text: formattedBody };
        const mentionedJid = baileysOptions?.contextInfo?.mentionedJid;
        if (mentionedJid?.length) {
          messageContent.mentions = mentionedJid;
        }

        const sentMessage = await wbot.sendMessage(
          chatId,
          messageContent,
          baileysOptions
        );

        return sentMessage;
      });
    } catch (err) {
      Sentry.captureException(err);
      console.log(err);
      throw new AppError("ERR_SENDING_WAPP_MSG");
    }
  }

  async sendMedia(
    whatsapp: Whatsapp,
    number: string,
    mediaPath: string,
    options?: SendMediaOptions
  ): Promise<WAMessage> {
    try {
      return this.enqueueSend(whatsapp.id, async () => {
        const wbot = await GetWhatsappWbot(whatsapp);
        // CORREÇÃO: Usar buildChatJid para suportar grupos corretamente
        const chatId = this.buildChatJid(number);

        const messageOptions = await getMessageOptions(
          options?.fileName || "",
          mediaPath,
          options?.caption
        );

        if (!messageOptions) {
          throw new AppError("ERR_INVALID_MEDIA");
        }

        const sentMessage = await wbot.sendMessage(chatId, messageOptions);

        return sentMessage;
      });
    } catch (err) {
      Sentry.captureException(err);
      console.log(err);
      throw new AppError("ERR_SENDING_WAPP_MSG");
    }
  }

  async getStatus(whatsapp: Whatsapp): Promise<string> {
    return whatsapp.status || "DISCONNECTED";
  }
}

export default new BaileysProvider();

