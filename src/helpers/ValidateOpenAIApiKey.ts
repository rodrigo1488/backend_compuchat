import AppError from "../errors/AppError";
import { getLmStudioApiKey, isAiBackendConfigured } from "../config/openai";

/**
 * Garante que o backend de IA (LM Studio) está configurado via ambiente.
 * Não lê mais openaiApiKey por empresa.
 */
export const validateCompanyOpenAIApiKey = async (
  _companyId: number
): Promise<string> => {
  if (!isAiBackendConfigured()) {
    throw new AppError(
      "Servidor de IA não configurado. Defina LM_STUDIO_BASE_URL no ambiente do backend.",
      400
    );
  }
  return getLmStudioApiKey();
};
