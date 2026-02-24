import Setting from "../models/Setting";
import AppError from "../errors/AppError";
import { validateGeminiApiKey } from "../config/gemini";

/**
 * Valida se a empresa tem a API Key do Gemini configurada
 * @param companyId - ID da empresa
 * @returns A API key validada
 * @throws AppError se a API key não estiver configurada
 */
export const validateCompanyGeminiApiKey = async (
  companyId: number
): Promise<string> => {
  const geminiSetting = await Setting.findOne({
    where: {
      key: "geminiApiKey",
      companyId
    }
  });

  try {
    const apiKey = validateGeminiApiKey(geminiSetting?.value);
    return apiKey;
  } catch (err: any) {
    throw new AppError(
      "A API Key do Gemini não está configurada. Configure em Configurações → Integrações → Chave da API do Gemini.",
      400
    );
  }
};

