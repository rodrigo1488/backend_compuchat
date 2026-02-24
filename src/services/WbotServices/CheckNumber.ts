import AppError from "../../errors/AppError";
import GetDefaultWhatsApp from "../../helpers/GetDefaultWhatsApp";
import { getWbot } from "../../libs/wbot";
import { logger } from "../../utils/logger";

interface IOnWhatsapp {
  jid: string;
  exists: boolean;
}

const checker = async (number: string, wbot: any) => {
  const jid = number.includes("@") ? number : `${number}@s.whatsapp.net`;
  const [validNumber] = await wbot.onWhatsApp(jid);
  return validNumber;
};

const CheckContactNumber = async (
  number: string,
  companyId: number
): Promise<IOnWhatsapp> => {
  const defaultWhatsapp = await GetDefaultWhatsApp(companyId);

  const wbot = getWbot(defaultWhatsapp.id);
  const isNumberExit = await checker(number, wbot);

  if (!isNumberExit) {
    throw new AppError("ERR_CHECK_NUMBER");
  }
  return isNumberExit;
};

export default CheckContactNumber;
