import axios from "axios";
import Setting from "../../models/Setting";
import { validateGeminiApiKey } from "../../config/gemini";
import { logger } from "../../utils/logger";
import { GEMINI_BASE_URL, GEMINI_MODEL } from "../../config/gemini";

export interface GeminiTokenInfo {
  available: boolean;
  tokensUsed?: number;
  tokensRemaining?: number;
  tokensTotal?: number;
  quotaExceeded?: boolean;
  error?: string;
}

/**
 * Verifica informações sobre tokens/quota do Gemini
 * Nota: A API do Gemini não fornece endpoint direto para verificar quota,
 * então fazemos uma chamada de teste para verificar se a API está funcionando
 */
const CheckGeminiTokensService = async (
  companyId: number
): Promise<GeminiTokenInfo> => {
  try {
    // Buscar API key do Gemini das Settings da empresa
    const geminiSetting = await Setting.findOne({
      where: {
        key: "geminiApiKey",
        companyId
      }
    });

    if (!geminiSetting?.value) {
      return {
        available: false,
        error: "API Key do Gemini não configurada"
      };
    }

    let apiKey: string;
    try {
      apiKey = validateGeminiApiKey(geminiSetting.value);
    } catch (err: any) {
      return {
        available: false,
        error: `API Key inválida: ${err.message}`
      };
    }

    // Fazer uma chamada de teste para verificar se a API está funcionando
    // e se há quota disponível
    try {
      const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent`;
      const response = await axios.post(
        `${url}?key=${apiKey}`,
        {
          contents: [
            {
              parts: [{ text: "test" }]
            }
          ],
          generationConfig: {
            maxOutputTokens: 1
          }
        },
        {
          timeout: 10000,
          validateStatus: (status) => status < 500 // Aceitar 4xx como resposta válida
        }
      );

      // Se chegou aqui, a API está funcionando
      // Tentar extrair informações de tokens da resposta
      const usageMetadata = response.data?.usageMetadata;
      const promptTokens = usageMetadata?.promptTokenCount || 0;
      const candidatesTokenCount = usageMetadata?.candidatesTokenCount || 0;
      const totalTokens = usageMetadata?.totalTokenCount || (promptTokens + candidatesTokenCount);

      // A API do Gemini não fornece quota total diretamente via API pública
      // Mas podemos mostrar os tokens usados na última chamada de teste
      // Nota: Este é apenas um exemplo da última chamada, não o total acumulado
      return {
        available: true,
        tokensUsed: totalTokens > 0 ? totalTokens : undefined,
        tokensRemaining: undefined, // Não disponível via API pública do Gemini
        tokensTotal: undefined // Não disponível via API pública do Gemini
      };
    } catch (error: any) {
      if (error.response?.status === 429) {
        return {
          available: false,
          quotaExceeded: true,
          error: "Quota excedida"
        };
      }
      if (error.response?.status === 403) {
        return {
          available: false,
          quotaExceeded: true,
          error: "Acesso negado - verifique sua quota"
        };
      }
      if (error.response?.status === 401) {
        return {
          available: false,
          error: "API Key inválida"
        };
      }

      // Outros erros
      return {
        available: false,
        error: error.message || "Erro ao verificar quota do Gemini"
      };
    }
  } catch (error: any) {
    logger.error(`Erro ao verificar tokens do Gemini para empresa ${companyId}:`, error);
    return {
      available: false,
      error: error.message || "Erro desconhecido"
    };
  }
};

export default CheckGeminiTokensService;
