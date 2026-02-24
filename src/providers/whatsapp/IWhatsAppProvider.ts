import Whatsapp from "../../models/Whatsapp";

export interface SendMessageOptions {
  quotedMsg?: any;
  [key: string]: any;
}

export interface SendMediaOptions {
  fileName?: string;
  caption?: string;
  mimetype?: string;
  [key: string]: any;
}

export interface IWhatsAppProvider {
  /**
   * Envia uma mensagem de texto
   */
  sendMessage(
    whatsapp: Whatsapp,
    number: string,
    body: string,
    options?: SendMessageOptions
  ): Promise<any>;

  /**
   * Envia uma mídia (imagem, vídeo, áudio, documento)
   */
  sendMedia(
    whatsapp: Whatsapp,
    number: string,
    mediaPath: string,
    options?: SendMediaOptions
  ): Promise<any>;

  /**
   * Obtém o status da conexão
   */
  getStatus(whatsapp: Whatsapp): Promise<string>;
}

