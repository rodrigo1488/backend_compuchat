import path from "path";
import fs from "fs";
import axios from "axios";
import { cacheLayer } from "../../libs/cache";
import { logger } from "../../utils/logger";
import uploadConfig from "../../config/upload";
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
      timeout: 15000,
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

export const fetchAndPersistProfilePic = async (
  wbot: WbotProfile,
  jid: string,
  companyId: number,
  number: string
): Promise<string> => {
  const fallback = fallbackProfilePicUrl();
  const cacheKey = `profilepic:stored:${companyId}:${jid}`;
  const localPath = getLocalProfilePicPath(companyId, number);
  const publicUrl = getLocalProfilePicPublicUrl(companyId, number);

  if (fs.existsSync(localPath)) {
    try {
      await cacheLayer.set(cacheKey, publicUrl, "EX", PROFILE_PIC_FETCH_TTL_SECONDS);
    } catch (_) {}
    return publicUrl;
  }

  try {
    const cached = await cacheLayer.get(cacheKey);
    if (cached && !isWhatsAppCdnProfileUrl(cached)) {
      return cached;
    }
  } catch (_) {}

  try {
    const whatsappUrl = await wbot.profilePictureUrl(jid, "image");
    if (!whatsappUrl) {
      try {
        await cacheLayer.set(cacheKey, fallback, "EX", 300);
      } catch (_) {}
      return fallback;
    }

    const storedUrl = await persistProfilePictureFromUrl(
      whatsappUrl,
      companyId,
      number
    );
    try {
      await cacheLayer.set(cacheKey, storedUrl, "EX", PROFILE_PIC_FETCH_TTL_SECONDS);
    } catch (_) {}
    return storedUrl;
  } catch (err: any) {
    logger.debug(
      `[profilePic] profilePictureUrl falhou (${jid}): ${err?.message || err}`
    );
    if (fs.existsSync(localPath)) {
      return publicUrl;
    }
    try {
      await cacheLayer.set(cacheKey, fallback, "EX", 300);
    } catch (_) {}
    return fallback;
  }
};
