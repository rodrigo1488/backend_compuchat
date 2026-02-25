import * as Sentry from "@sentry/node";
import makeWASocket, {
  WASocket,
  WAVersion,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  // makeInMemoryStore,
  isJidBroadcast
} from "baileys";

import Whatsapp from "../models/Whatsapp";
import { logger } from "../utils/logger";
import pino from "pino";
import authState from "../helpers/authState";
import { Boom } from "@hapi/boom";
import AppError from "../errors/AppError";
import { getIO } from "./socket";
import { Store } from "./store";
import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
import DeleteBaileysService from "../services/BaileysServices/DeleteBaileysService";
import CloseTicketsByWhatsAppIdService from "../services/TicketServices/CloseTicketsByWhatsAppIdService";
import NodeCache from 'node-cache';

// Usar pino diretamente ao invés de path interno do Baileys (compatível com Baileys 7.x)
const loggerBaileys = pino({ 
  level: "error",
  transport: process.env.NODE_ENV === "development" ? {
    target: "pino-pretty",
    options: { colorize: true }
  } : undefined
});

type Session = WASocket & {
  id?: number;
  store?: Store;
};

const sessions: Session[] = [];

const retriesQrCodeMap = new Map<number, number>();

// Mapa para rastrear sessões em processo de inicialização
const initializingSessions = new Map<number, boolean>();

// Mapa para contagem de reconexões por sessão (backoff exponencial)
const reconnectAttemptsMap = new Map<number, number>();

// Cache da versão do Baileys — buscada apenas uma vez por processo,
// evitando uma requisição HTTP externa a cada reconexão de sessão.
let baileysVersionCache: { version: WAVersion; isLatest: boolean } | null = null;

const getBaileysVersion = async () => {
  if (baileysVersionCache) return baileysVersionCache;
  baileysVersionCache = await fetchLatestBaileysVersion();
  return baileysVersionCache;
};

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);

  if (sessionIndex === -1) {
    throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  }
  return sessions[sessionIndex];
};

export const removeWbot = async (
  whatsappId: number,
  isLogout = true
): Promise<void> => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
    if (sessionIndex !== -1) {
      if (isLogout) {
        sessions[sessionIndex].logout();
        sessions[sessionIndex].ws.close();
      }

      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
};

export const initWASocket = async (whatsapp: Whatsapp): Promise<Session> => {
  return new Promise(async (resolve, reject) => {
    try {
      (async () => {
        const io = getIO();

        const whatsappUpdate = await Whatsapp.findOne({
          where: { id: whatsapp.id }
        });

        if (!whatsappUpdate) return;

        const { id, name, provider } = whatsappUpdate;

        // Verificar se já existe uma sessão ativa
        const existingSession = sessions.find(s => s.id === id);
        if (existingSession) {
          logger.info(`Sessão ${name} já existe. Retornando sessão existente.`);
          resolve(existingSession as Session);
          return;
        }

        // Verificar se já está em processo de inicialização
        if (initializingSessions.get(id)) {
          logger.warn(`Sessão ${name} já está em processo de inicialização. Aguardando...`);
          // Aguardar até 10 segundos para a inicialização completar
          let attempts = 0;
          while (initializingSessions.get(id) && attempts < 20) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const session = sessions.find(s => s.id === id);
            if (session) {
              resolve(session as Session);
              return;
            }
            attempts++;
          }
          logger.warn(`Timeout aguardando inicialização da sessão ${name}.`);
        }

        // Marcar como em inicialização
        initializingSessions.set(id, true);

        const { version, isLatest } = await getBaileysVersion();
        const isLegacy = provider === "stable" ? true : false;

        logger.info(`using WA v${version.join(".")}, isLatest: ${isLatest}`);
        logger.info(`isLegacy: ${isLegacy}`);
        logger.info(`Starting session ${name}`);
        let retriesQrCode = 0;

        let wsocket: Session = null;
        // const store = makeInMemoryStore({
        //   logger: loggerBaileys
        // });

        const { state, saveState } = await authState(whatsapp);

        const msgRetryCounterCache = new NodeCache();

        wsocket = makeWASocket({
          logger: loggerBaileys,
          printQRInTerminal: false,
          browser: Browsers.appropriate("Desktop"),
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
          },
          version,
          // defaultQueryTimeoutMs: 60000,
          retryRequestDelayMs: 250, // espera entre tentativas de reenvio de mensagens falhas
          keepAliveIntervalMs: 1000 * 60, // 60s — evita conexão "zumbi"
          msgRetryCounterCache,
          shouldIgnoreJid: jid => isJidBroadcast(jid),
        });

        // wsocket = makeWASocket({
        //   version,
        //   logger: loggerBaileys,
        //   printQRInTerminal: false,
        //   auth: state as AuthenticationState,
        //   generateHighQualityLinkPreview: false,
        //   shouldIgnoreJid: jid => isJidBroadcast(jid),
        //   browser: ["Chat", "Chrome", "10.15.7"],
        //   patchMessageBeforeSending: (message) => {
        //     const requiresPatch = !!(
        //       message.buttonsMessage ||
        //       // || message.templateMessage
        //       message.listMessage
        //     );
        //     if (requiresPatch) {
        //       message = {
        //         viewOnceMessage: {
        //           message: {
        //             messageContextInfo: {
        //               deviceListMetadataVersion: 2,
        //               deviceListMetadata: {},
        //             },
        //             ...message,
        //           },
        //         },
        //       };
        //     }

        //     return message;
        //   },
        // })

        wsocket.ev.on(
          "connection.update",
          async ({ connection, lastDisconnect, qr }) => {
            logger.info(
              `Socket  ${name} Connection Update ${connection || ""} ${lastDisconnect || ""
              }`
            );

            if (connection === "close") {
              // Limpar flag de inicialização
              initializingSessions.delete(id);

              const disconnectStatusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

              // Incrementar contador de reconexões para backoff exponencial
              const currentAttempts = reconnectAttemptsMap.get(id) ?? 0;

              if (disconnectStatusCode === 403) {
                // Conta banida/proibida — limpar sessão, NÃO reconectar (evita loop)
                reconnectAttemptsMap.delete(id);
                logger.warn({
                  msg: `Whatsapp desconectado com 403 (proibido/banido). Limpando sessão sem reconectar.`,
                  whatsappId: id,
                  whatsappName: name,
                  companyId: whatsapp.companyId,
                  disconnectCode: 403
                });
                await whatsapp.update({ status: "PENDING", session: "" });
                await DeleteBaileysService(whatsapp.id);
                io.to(`company-${whatsapp.companyId}-mainchannel`).emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
                removeWbot(id, false);
              } else if (disconnectStatusCode !== DisconnectReason.loggedOut) {
                // Desconexão por rede/timeout/erro transitório — reconectar com backoff exponencial
                const nextAttempt = currentAttempts + 1;
                reconnectAttemptsMap.set(id, nextAttempt);
                // Backoff: min(2^n * 1000, 60000) ms → 2s, 4s, 8s, 16s, 32s, 60s (máx)
                const delay = Math.min(Math.pow(2, nextAttempt) * 1000, 60000);
                logger.warn({
                  msg: `Whatsapp desconectado. Reconectando com backoff.`,
                  whatsappId: id,
                  whatsappName: name,
                  companyId: whatsapp.companyId,
                  disconnectCode: disconnectStatusCode ?? "unknown",
                  reconnectAttempt: nextAttempt,
                  delayMs: delay
                });
                removeWbot(id, false);
                // Não reconectar se for Instagram ou Gupshup (não usam Baileys)
                setTimeout(
                  () => {
                    if (!initializingSessions.get(id) && whatsapp.type !== "instagram" && whatsapp.provider !== "gupshup") {
                      StartWhatsAppSession(whatsapp, whatsapp.companyId);
                    }
                  },
                  delay
                );
              } else {
                // loggedOut (401) — deslogado pelo WhatsApp, limpar sessão e aguardar novo QR
                reconnectAttemptsMap.delete(id);
                logger.warn({
                  msg: `Whatsapp desconectado por logout (401). Limpando sessão e aguardando novo QR.`,
                  whatsappId: id,
                  whatsappName: name,
                  companyId: whatsapp.companyId,
                  disconnectCode: DisconnectReason.loggedOut
                });
                await whatsapp.update({ status: "PENDING", session: "" });
                await DeleteBaileysService(whatsapp.id);
                io.to(`company-${whatsapp.companyId}-mainchannel`).emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
                removeWbot(id, false);
                // Aguardar antes de reconectar para exibir QR de nova autenticação
                // Não reconectar se for Instagram ou Gupshup (não usam Baileys)
                setTimeout(
                  () => {
                    if (!initializingSessions.get(id) && whatsapp.type !== "instagram" && whatsapp.provider !== "gupshup") {
                      StartWhatsAppSession(whatsapp, whatsapp.companyId);
                    }
                  },
                  2000
                );
              }
            }

            if (connection === "open") {
              // Reconectou com sucesso — zerar contador de tentativas
              reconnectAttemptsMap.delete(id);
              await whatsapp.update({
                status: "CONNECTED",
                qrcode: "",
                retries: 0
              });

              io.to(`company-${whatsapp.companyId}-mainchannel`).emit(`company-${whatsapp.companyId}-whatsappSession`, {
                action: "update",
                session: whatsapp
              });

              const sessionIndex = sessions.findIndex(
                s => s.id === whatsapp.id
              );
              if (sessionIndex === -1) {
                wsocket.id = whatsapp.id;
                sessions.push(wsocket);
              }

              // Remover do mapa de inicialização
              initializingSessions.delete(id);
              
              resolve(wsocket);
            }

            if (qr !== undefined) {
              if (retriesQrCodeMap.get(id) && retriesQrCodeMap.get(id) >= 3) {
                await whatsappUpdate.update({
                  status: "DISCONNECTED",
                  qrcode: ""
                });
                await CloseTicketsByWhatsAppIdService(whatsappUpdate.id);
                await DeleteBaileysService(whatsappUpdate.id);
                io.to(`company-${whatsapp.companyId}-mainchannel`).emit("whatsappSession", {
                  action: "update",
                  session: whatsappUpdate
                });
                wsocket.ev.removeAllListeners("connection.update");
                wsocket.ws.close();
                wsocket = null;
                retriesQrCodeMap.delete(id);
              } else {
                logger.info(`Session QRCode Generate ${name}`);
                retriesQrCodeMap.set(id, (retriesQrCode += 1));

                await whatsapp.update({
                  qrcode: qr,
                  status: "qrcode",
                  retries: 0
                });
                const sessionIndex = sessions.findIndex(
                  s => s.id === whatsapp.id
                );

                if (sessionIndex === -1) {
                  wsocket.id = whatsapp.id;
                  sessions.push(wsocket);
                }

                io.to(`company-${whatsapp.companyId}-mainchannel`).emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
              }
            }
          }
        );
        wsocket.ev.on("creds.update", saveState);

        //store.bind(wsocket.ev);
      })();
    } catch (error) {
      // Limpar flag de inicialização em caso de erro
      if (whatsapp?.id) {
        initializingSessions.delete(whatsapp.id);
      }
      Sentry.captureException(error);
      console.log(error);
      reject(error);
    }
  });
};
