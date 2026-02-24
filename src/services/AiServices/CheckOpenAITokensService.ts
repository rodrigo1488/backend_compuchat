import { Configuration, OpenAIApi } from "openai";
import Setting from "../../models/Setting";
import { logger } from "../../utils/logger";

export interface OpenAITokenInfo {
  available: boolean;
  tokensUsed?: number;
  tokensRemaining?: number;
  tokensTotal?: number;
  quotaExceeded?: boolean;
  error?: string;
}

/**
 * Verifica informações sobre tokens/quota do OpenAI
 * Usa a API de usage do OpenAI para verificar informações de quota
 */
const CheckOpenAITokensService = async (
  companyId: number
): Promise<OpenAITokenInfo> => {
  try {
    // Buscar API key do OpenAI das Settings da empresa
    const openaiSetting = await Setting.findOne({
      where: {
        key: "openaiApiKey",
        companyId
      }
    });

    if (!openaiSetting?.value) {
      return {
        available: false,
        error: "API Key do OpenAI não configurada"
      };
    }

    try {
      const configuration = new Configuration({
        apiKey: openaiSetting.value
      });
      const openai = new OpenAIApi(configuration);

      // Fazer uma chamada de teste para verificar se a API está funcionando
      // A API do OpenAI não fornece endpoint direto para verificar quota,
      // então fazemos uma chamada de teste mínima
      try {
        const completion = await openai.createChatCompletion({
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: "test" }],
          max_tokens: 1
        });

        // Se chegou aqui, a API está funcionando
        // Extrair informações de tokens da resposta
        const usage = completion.data.usage;
        const promptTokens = usage?.prompt_tokens || 0;
        const completionTokens = usage?.completion_tokens || 0;
        const totalTokens = usage?.total_tokens || (promptTokens + completionTokens);

        // A API do OpenAI não fornece quota total diretamente via API pública
        // Mas podemos mostrar os tokens usados na última chamada
        return {
          available: true,
          tokensUsed: totalTokens,
          tokensRemaining: undefined, // Não disponível via API pública
          tokensTotal: undefined // Não disponível via API pública
        };
      } catch (error: any) {
        if (error.response?.status === 429) {
          const errorType = error.response?.data?.error?.type;
          if (errorType === "insufficient_quota") {
            return {
              available: false,
              quotaExceeded: true,
              error: "Quota insuficiente"
            };
          }
          if (errorType === "rate_limit_exceeded") {
            return {
              available: false,
              quotaExceeded: false,
              error: "Limite de taxa excedido"
            };
          }
          return {
            available: false,
            quotaExceeded: true,
            error: "Limite de uso atingido"
          };
        }
        if (error.response?.status === 401) {
          return {
            available: false,
            error: "API Key inválida"
          };
        }
        if (error.response?.status === 403) {
          return {
            available: false,
            quotaExceeded: true,
            error: "Acesso negado - verifique sua quota"
          };
        }

        // Outros erros
        return {
          available: false,
          error: error.response?.data?.error?.message || error.message || "Erro ao verificar quota do OpenAI"
        };
      }
    } catch (error: any) {
      return {
        available: false,
        error: error.message || "Erro ao configurar cliente OpenAI"
      };
    }
  } catch (error: any) {
    logger.error(`Erro ao verificar tokens do OpenAI para empresa ${companyId}:`, error);
    return {
      available: false,
      error: error.message || "Erro desconhecido"
    };
  }
};

export default CheckOpenAITokensService;
