import { IAIProvider } from "./AIProviderInterface";
import { OpenAIProvider } from "./providers/OpenAIProvider";
import { isAiBackendConfigured } from "../../config/openai";
import AppError from "../../errors/AppError";

/**
 * Factory para o cliente OpenAI-compatível (LM Studio), configurado globalmente via ambiente.
 */
export class AIProviderFactory {
  /**
   * Cria instância do provider (LM Studio). companyId é ignorado — mantido só por compatibilidade de chamadas.
   */
  static async createOpenAIProvider(_companyId?: number): Promise<OpenAIProvider> {
    if (!isAiBackendConfigured()) {
      throw new AppError(
        "Servidor de IA não configurado. Defina LM_STUDIO_BASE_URL no ambiente do backend.",
        400
      );
    }
    return new OpenAIProvider();
  }

  /**
   * Disponibilidade de IA: apenas LM Studio (openai-compat). gemini permanece false para compatibilidade de tipos legados.
   */
  static async getAvailableProviders(_companyId?: number): Promise<{
    gemini: boolean;
    openai: boolean;
  }> {
    const ok = isAiBackendConfigured();
    return {
      gemini: false,
      openai: ok
    };
  }
}
