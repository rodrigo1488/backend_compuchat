import ListWhatsAppsService from "../WhatsappService/ListWhatsAppsService";
import { StartWhatsAppSession } from "./StartWhatsAppSession";
import * as Sentry from "@sentry/node";
import { logger } from "../../utils/logger";

export const StartAllWhatsAppsSessions = async (
  companyId: number
): Promise<void> => {
  try {
    const whatsapps = await ListWhatsAppsService({ companyId });
    if (whatsapps.length > 0) {
      whatsapps.forEach(whatsapp => {
        if (whatsapp.type === "instagram" || whatsapp.provider === "instagram") {
          logger.info(`StartAllWhatsAppsSessions: Skipping Instagram session ${whatsapp.name}`);
          return;
        }
        StartWhatsAppSession(whatsapp, companyId);
      });
    }
  } catch (e) {
    Sentry.captureException(e);
  }
};
