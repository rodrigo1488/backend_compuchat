import { IAIProvider } from "./AIProviderInterface";
import { AIProviderFactory } from "./AIProviderFactory";
import AppError from "../../errors/AppError";

export type AIFunctionType =
  | "summaries"
  | "chat"
  | "messageImprovement"
  | "transcription"
  | "campaigns";

const ALL_FUNCTIONS: AIFunctionType[] = [
  "summaries",
  "chat",
  "messageImprovement",
  "transcription",
  "campaigns"
];

/**
 * Todas as funcionalidades usam o mesmo servidor LM Studio (OpenAI-compat).
 */
export class AIProviderSelector {
  static async getProvider(
    companyId: number,
    _functionType: AIFunctionType
  ): Promise<IAIProvider> {
    const available = await AIProviderFactory.getAvailableProviders(companyId);
    if (!available.openai) {
      throw new AppError(
        "Servidor de IA não configurado. O administrador deve definir LM_STUDIO_BASE_URL no ambiente do backend.",
        400
      );
    }
    return AIProviderFactory.createOpenAIProvider(companyId);
  }

  static async getProviderName(
    companyId: number,
    _functionType: AIFunctionType
  ): Promise<"openai"> {
    const available = await AIProviderFactory.getAvailableProviders(companyId);
    if (!available.openai) {
      throw new AppError(
        "Servidor de IA não configurado.",
        400
      );
    }
    return "openai";
  }

  static async getProviderConfigurations(companyId: number): Promise<{
    available: { gemini: boolean; openai: boolean };
    configured: Record<AIFunctionType, "openai">;
  }> {
    const available = await AIProviderFactory.getAvailableProviders(companyId);
    const configured = {} as Record<AIFunctionType, "openai">;
    ALL_FUNCTIONS.forEach(ft => {
      configured[ft] = "openai";
    });
    return {
      available,
      configured
    };
  }
}
