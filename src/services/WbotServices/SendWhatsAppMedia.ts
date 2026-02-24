import { WAMessage, AnyMessageContent } from "baileys";
import * as Sentry from "@sentry/node";
import fs from "fs";
import { exec } from "child_process";
import path from "path";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import AppError from "../../errors/AppError";
import Ticket from "../../models/Ticket";
import { lookup } from "mime-types";
import formatBody from "../../helpers/Mustache";

interface Request {
  media: Express.Multer.File;
  ticket: Ticket;
  body?: string;
}

const publicFolder = path.resolve(__dirname, "..", "..", "..", "public");

const processAudio = async (audio: string): Promise<string> => {
  const outputAudio = `${publicFolder}/${new Date().getTime()}.mp3`;
  return new Promise((resolve, reject) => {
    exec(
      `${ffmpegPath.path} -i ${audio} -vn -ab 128k -ar 44100 -f ipod ${outputAudio} -y`,
      (error, _stdout, _stderr) => {
        if (error) reject(error);
        fs.unlinkSync(audio);
        resolve(outputAudio);
      }
    );
  });
};

const processAudioFile = async (audio: string): Promise<string> => {
  const outputAudio = `${publicFolder}/${new Date().getTime()}.mp3`;
  return new Promise((resolve, reject) => {
    exec(
      `${ffmpegPath.path} -i ${audio} -vn -ar 44100 -ac 2 -b:a 192k ${outputAudio}`,
      (error, _stdout, _stderr) => {
        if (error) reject(error);
        fs.unlinkSync(audio);
        resolve(outputAudio);
      }
    );
  });
};

export const getMessageOptions = async (
  fileName: string,
  pathMedia: string,
  body?: string
): Promise<any> => {
  const mimeType = lookup(pathMedia) || "";
  const typeMessage = mimeType.split("/")[0];

  try {
    if (!mimeType) {
      throw new Error("Invalid mimetype");
    }
    let options: AnyMessageContent;

    if (typeMessage === "video") {
      options = {
        video: fs.readFileSync(pathMedia),
        caption: body ? body : "",
        fileName: fileName
        // gifPlayback: true
      };
    } else if (typeMessage === "audio") {
      const typeAudio = true; //fileName.includes("audio-record-site");
      const convert = await processAudio(pathMedia);
      if (typeAudio) {
        options = {
          audio: fs.readFileSync(convert),
          mimetype: typeAudio ? "audio/mp4" : mimeType,
          caption: body ? body : null,
          ptt: true
        };
      } else {
        options = {
          audio: fs.readFileSync(convert),
          mimetype: typeAudio ? "audio/mp4" : mimeType,
          caption: body ? body : null,
          ptt: true
        };
      }
    } else if (typeMessage === "document") {
      options = {
        document: fs.readFileSync(pathMedia),
        caption: body ? body : null,
        fileName: fileName,
        mimetype: mimeType
      };
    } else if (typeMessage === "application") {
      options = {
        document: fs.readFileSync(pathMedia),
        caption: body ? body : null,
        fileName: fileName,
        mimetype: mimeType
      };
    } else {
      options = {
        image: fs.readFileSync(pathMedia),
        caption: body ? body : null
      };
    }

    return options;
  } catch (e) {
    Sentry.captureException(e);
    console.log(e);
    return null;
  }
};

const SendWhatsAppMedia = async ({
  media,
  ticket,
  body
}: Request): Promise<WAMessage | any> => {
  try {
    // Obter whatsapp do ticket
    const Whatsapp = (await import("../../models/Whatsapp")).default;
    const whatsapp = await Whatsapp.findByPk(ticket.whatsappId);
    if (!whatsapp) {
      throw new AppError("ERR_WAPP_NOT_FOUND");
    }

    const pathMedia = media.path;
    const typeMessage = media.mimetype.split("/")[0];
    const bodyMessage = formatBody(body, ticket.contact);
    const number = ticket.contact.number;

    // Se for Instagram, usa o Adapter
    if (whatsapp.type === "instagram") {
      const { ChannelAdapterFactory } = require("../ChannelAdapters/ChannelAdapterFactory");
      const adapter = ChannelAdapterFactory(whatsapp);
      try {
        const sentMessage = await adapter.sendMedia(whatsapp, ticket.contact, {
          mediaPath: pathMedia,
          fileName: media.originalname,
          mimetype: media.mimetype,
          caption: bodyMessage
        });
        await ticket.update({ lastMessage: bodyMessage });
        return sentMessage;
      } catch (err) {
        Sentry.captureException(err);
        console.log(err);
        throw new AppError("ERR_SENDING_INSTAGRAM_MEDIA");
      }
    }

    // Para Baileys, ainda precisa processar áudio
    let finalMediaPath = pathMedia;
    if (typeMessage === "audio") {
      const typeAudio = media.originalname.includes("audio-record-site");
      if (typeAudio) {
        finalMediaPath = await processAudio(media.path);
      } else {
        finalMediaPath = await processAudioFile(media.path);
      }
    }

    const WhatsAppService = (await import("../WhatsAppService")).default;
    const sentMessage = await WhatsAppService.sendMedia(
      whatsapp,
      number,
      finalMediaPath,
      {
        fileName: media.originalname,
        caption: bodyMessage,
        mimetype: media.mimetype
      }
    );

    await ticket.update({ lastMessage: bodyMessage });

    return sentMessage;
  } catch (err) {
    Sentry.captureException(err);
    console.log(err);
    throw new AppError("ERR_SENDING_WAPP_MSG");
  }
};

export default SendWhatsAppMedia;
