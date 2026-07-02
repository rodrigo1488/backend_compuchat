import path from "path";
import fs from "fs";
import axios from "axios";
import { cacheLayer } from "../../libs/cache";
import { logger } from "../../utils/logger";
import uploadConfig from "../../config/upload";
import Contact from "../../models/Contact";
import { getIO } from "../../libs/socket";
import {
  fallbackProfilePicUrl,
  isLocalContactProfileUrl,
  isWhatsAppCdnProfileUrl
} from "../../helpers/contactProfilePic";

type WbotProfile = {
  profilePictureUrl: (
    jid: string,
    type?: "preview" | "image",
    timeoutMs?: number
  ) => Promise<string | undefined>;
};

const PROFILE_PIC_FETCH_TTL_SECONDS = 60 * 60 * 6;
const PROFILE_PIC_THROTTLE_SECONDS = 10 * 60;

export const getLocalProfilePicPath = (
  companyId: number,
  number: string
): string => {
  const safeNumber = number.replace(/\D/g, "") || "unknown";
  return path.join(
    uploadConfig.directory,
    "contacts",
    String(companyId),
    `${safeNumber}.jpg`
  );
};

export const getLocalProfilePicPublicUrl = (
  companyId: number,
  number: string
): string => {
  const safeNumber = number.replace(/\D/g, "") || "unknown";
  const base = (process.env.BACKEND_URL || "").replace(/\/$/, "");
  return `${base}/public/contacts/${companyId}/${safeNumber}.jpg`;
};

export const persistProfilePictureFromUrl = async (
  whatsappUrl: string,
  companyId: number,
  number: string
): Promise<string> => {
  const fallback = fallbackProfilePicUrl();
  if (!whatsappUrl || whatsappUrl.includes("nopicture")) {
    return fallback;
  }

  const localPath = getLocalProfilePicPath(companyId, number);
  const publicUrl = getLocalProfilePicPublicUrl(companyId, number);

  try {
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    const response = await axios.get<ArrayBuffer>(whatsappUrl, {
      responseType: "arraybuffer",
      timeout: 8000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "image/*,*/*"
      },
      validateStatus: status => status === 200
    });
    await fs.promises.writeFile(localPath, Buffer.from(response.data));
    return publicUrl;
  } catch (err: any) {
    logger.debug(
      `[profilePic] falha ao baixar foto (${number}): ${err?.message || err}`
    );
    if (fs.existsSync(localPath)) {
      return publicUrl;
    }
    return fallback;
  }
};

export const shouldRefreshContactProfilePic = (
  profilePicUrl: string | null | undefined,
  companyId: number,
  number: string
): boolean => {
  if (!profilePicUrl || profilePicUrl.includes("nopicture")) {
    return true;
  }
  if (isWhatsAppCdnProfileUrl(profilePicUrl)) {
    return true;
  }
  if (isLocalContactProfileUrl(profilePicUrl)) {
    return !fs.existsSync(getLocalProfilePicPath(companyId, number));
  }
  return false;
};

/** Caminho rápido no processamento de mensagens — nunca bloqueia em rede. */
export const resolveProfilePicForInboundMessage = (
  profilePicUrl: string | null | undefined,
  companyId: number,
  number: string
): string => {
  if (
    profilePicUrl &&
    isLocalContactProfileUrl(profilePicUrl) &&
    fs.existsSync(getLocalProfilePicPath(companyId, number))
  ) {
    return profilePicUrl;
  }
  return fallbackProfilePicUrl();
};

const updateContactProfilePicInDb = async (
  contactId: number,
  companyId: number,
  profilePicUrl: string
): Promise<Contact | null> => {
  const contact = await Contact.findByPk(contactId);
  if (!contact || contact.profilePicUrl === profilePicUrl) {
    return contact;
  }

  await contact.update({ profilePicUrl });
  await contact.reload();
  const io = getIO();
  io.to(`company-${companyId}-mainchannel`).emit(`company-${companyId}-contact`, {
    action: "update",
    contact
  });
  return contact;
};

/** Busca foto atual no WhatsApp, ignora cache local e throttle. */
export const forceRefreshContactProfilePic = async (
  wbot: WbotProfile,
  jid: string,
  companyId: number,
  number: string,
  contactId: number
): Promise<string> => {
  const fallback = fallbackProfilePicUrl();
  const localPath = getLocalProfilePicPath(companyId, number);

  try {
    if (fs.existsSync(localPath)) {
      await fs.promises.unlink(localPath);
    }
  } catch (_) {}

  try {
    const whatsappUrl = await wbot.profilePictureUrl(jid, "image", 8000);
    if (!whatsappUrl) {
      return fallback;
    }

    const url = await persistProfilePictureFromUrl(
      whatsappUrl,
      companyId,
      number
    );

    if (!url.includes("nopicture")) {
      await updateContactProfilePicInDb(contactId, companyId, url);
    }

    return url;
  } catch (err: any) {
    logger.debug(
      `[profilePic] refresh manual falhou (${number}): ${err?.message || err}`
    );
    if (fs.existsSync(localPath)) {
      return getLocalProfilePicPublicUrl(companyId, number);
    }
    return fallback;
  }
};

export const fetchAndPersistProfilePic = async (
  wbot: WbotProfile,
  jid: string,
  companyId: number,
  number: string
): Promise<string> => {
  const fallback = fallbackProfilePicUrl();
  const localPath = getLocalProfilePicPath(companyId, number);
  const publicUrl = getLocalProfilePicPublicUrl(companyId, number);

  if (fs.existsSync(localPath)) {
    return publicUrl;
  }

  try {
    const whatsappUrl = await wbot.profilePictureUrl(jid, "image", 5000);
    if (!whatsappUrl) {
      return fallback;
    }

    return await persistProfilePictureFromUrl(whatsappUrl, companyId, number);
  } catch (err: any) {
    logger.debug(
      `[profilePic] profilePictureUrl falhou (${jid}): ${err?.message || err}`
    );
    if (fs.existsSync(localPath)) {
      return publicUrl;
    }
    return fallback;
  }
};

const refreshContactProfilePicInBackground = async (
  wbot: WbotProfile,
  jid: string,
  companyId: number,
  number: string,
  contactId?: number
): Promise<void> => {
  const throttleKey = `profilepic:throttle:${companyId}:${number.replace(/\D/g, "")}`;
  try {
    const throttled = await cacheLayer.get(throttleKey);
    if (throttled) {
      return;
    }
    await cacheLayer.set(throttleKey, "1", "EX", PROFILE_PIC_THROTTLE_SECONDS);
  } catch (_) {}

  const url = await fetchAndPersistProfilePic(wbot, jid, companyId, number);
  if (url.includes("nopicture")) {
    return;
  }

  if (contactId) {
    await updateContactProfilePicInDb(contactId, companyId, url);
    return;
  }

  const contact = await Contact.findOne({ where: { companyId, number } });
  if (contact) {
    await updateContactProfilePicInDb(contact.id, companyId, url);
  }
};

/** Atualiza foto em background para não atrasar messages.upsert. */
export const scheduleContactProfilePicRefresh = (
  wbot: WbotProfile,
  jid: string,
  companyId: number,
  number: string,
  contactId?: number
): void => {
  setImmediate(() => {
    refreshContactProfilePicInBackground(
      wbot,
      jid,
      companyId,
      number,
      contactId
    ).catch(err => {
      logger.debug(
        `[profilePic] refresh em background falhou (${number}): ${err?.message || err}`
      );
    });
  });
};
