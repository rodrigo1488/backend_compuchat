import Setting from "../models/Setting";
import AppError from "../errors/AppError";
import { validateOpenAIApiKey } from "../config/openai";

/**
 * Valida se a empresa tem a API Key do OpenAI configurada
 * @param companyId - ID da empresa
 * @returns A API key validada
 * @throws AppError se a API key não estiver configurada
 */
export const validateCompanyOpenAIApiKey = async (
  companyId: number
): Promise<string> => {
  const openaiSetting = await Setting.findOne({
    where: {
      key: "openaiApiKey",
      companyId
    }
  });

  try {
    const apiKey = validateOpenAIApiKey(openaiSetting?.value);
    return apiKey;
  } catch (err: any) {
    throw new AppError(
      "A API Key do OpenAI não está configurada. Configure em Configurações → Integrações → Chave da API do OpenAI.",
      400
    );
  }
};
