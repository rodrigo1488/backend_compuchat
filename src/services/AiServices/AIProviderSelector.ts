import Setting from "../../models/Setting";
import { IAIProvider } from "./AIProviderInterface";
import { AIProviderFactory } from "./AIProviderFactory";
import AppError from "../../errors/AppError";

/**
 * Tipos de funcionalidades de IA
 */
export type AIFunctionType =
  | "summaries"
  | "chat"
  | "messageImprovement"
  | "transcription"
  | "campaigns";

/**
 * Mapeamento de funcionalidades para chaves de Settings
 */
const FUNCTION_SETTING_KEYS: Record<AIFunctionType, string> = {
  summaries: "aiProviderSummaries",
  chat: "aiProviderChat",
  messageImprovement: "aiProviderMessageImprovement",
  transcription: "aiProviderTranscription",
  campaigns: "aiProviderCampaigns"
};

/**
 * Provider padrão para cada funcionalidade (se não configurado)
 */
const DEFAULT_PROVIDERS: Record<AIFunctionType, "gemini" | "openai"> = {
  summaries: "gemini",
  chat: "gemini",
  messageImprovement: "gemini",
  transcription: "gemini",
  campaigns: "gemini"
};

/**
 * Seleciona e retorna o provider apropriado para uma funcionalidade
 */
export class AIProviderSelector {
  /**
   * Obtém o provider para uma funcionalidade específica
   */
  static async getProvider(
    companyId: number,
    functionType: AIFunctionType
  ): Promise<IAIProvider> {
    // Verificar quais providers estão disponíveis
    const available = await AIProviderFactory.getAvailableProviders(companyId);

    if (!available.gemini && !available.openai) {
      throw new AppError(
        "Nenhuma API Key de IA configurada. Configure pelo menos uma API Key (Gemini ou OpenAI) em Configurações → Integrações.",
        400
      );
    }

    // Se apenas um provider está disponível, usar automaticamente
    if (available.gemini && !available.openai) {
      return await AIProviderFactory.createGeminiProvider(companyId);
    }

    if (available.openai && !available.gemini) {
      return await AIProviderFactory.createOpenAIProvider(companyId);
    }

    // Se ambos estão disponíveis, verificar configuração específica da funcionalidade
    const settingKey = FUNCTION_SETTING_KEYS[functionType];
    const providerSetting = await Setting.findOne({
      where: {
        key: settingKey,
        companyId
      }
    });

    // Se não houver configuração, usar o padrão
    const providerName = (providerSetting?.value || DEFAULT_PROVIDERS[functionType]) as "gemini" | "openai";

    // Validar que o provider escolhido está disponível
    // Se o provider escolhido não estiver disponível, tentar usar o outro se disponível
    if (providerName === "gemini" && !available.gemini) {
      // Se OpenAI está disponível, usar como fallback
      if (available.openai) {
        return await AIProviderFactory.createOpenAIProvider(companyId);
      }
      throw new AppError(
        `Provider Gemini configurado para ${functionType}, mas a API Key do Gemini não está configurada ou é inválida.`,
        400
      );
    }

    if (providerName === "openai" && !available.openai) {
      // Se Gemini está disponível, usar como fallback
      if (available.gemini) {
        return await AIProviderFactory.createGeminiProvider(companyId);
      }
      throw new AppError(
        `Provider OpenAI configurado para ${functionType}, mas a API Key do OpenAI não está configurada ou é inválida.`,
        400
      );
    }

    // Criar e retornar o provider
    if (providerName === "gemini") {
      return await AIProviderFactory.createGeminiProvider(companyId);
    } else {
      return await AIProviderFactory.createOpenAIProvider(companyId);
    }
  }

  /**
   * Obtém o nome do provider configurado para uma funcionalidade (sem criar instância)
   */
  static async getProviderName(
    companyId: number,
    functionType: AIFunctionType
  ): Promise<"gemini" | "openai"> {
    const available = await AIProviderFactory.getAvailableProviders(companyId);

    if (!available.gemini && !available.openai) {
      throw new AppError(
        "Nenhuma API Key de IA configurada.",
        400
      );
    }

    if (available.gemini && !available.openai) {
      return "gemini";
    }

    if (available.openai && !available.gemini) {
      return "openai";
    }

    // Ambos disponíveis, verificar configuração
    const settingKey = FUNCTION_SETTING_KEYS[functionType];
    const providerSetting = await Setting.findOne({
      where: {
        key: settingKey,
        companyId
      }
    });

    return (providerSetting?.value || DEFAULT_PROVIDERS[functionType]) as "gemini" | "openai";
  }

  /**
   * Obtém as configurações de providers da empresa
   */
  static async getProviderConfigurations(companyId: number): Promise<{
    available: { gemini: boolean; openai: boolean };
    configured: Record<AIFunctionType, "gemini" | "openai">;
  }> {
    const available = await AIProviderFactory.getAvailableProviders(companyId);

    const configured: Record<AIFunctionType, "gemini" | "openai"> = {
      summaries: DEFAULT_PROVIDERS.summaries,
      chat: DEFAULT_PROVIDERS.chat,
      messageImprovement: DEFAULT_PROVIDERS.messageImprovement,
      transcription: DEFAULT_PROVIDERS.transcription,
      campaigns: DEFAULT_PROVIDERS.campaigns
    };

    // Buscar todas as configurações de uma vez
    const settings = await Setting.findAll({
      where: {
        key: Object.values(FUNCTION_SETTING_KEYS),
        companyId
      }
    });

    settings.forEach(setting => {
      const functionType = Object.entries(FUNCTION_SETTING_KEYS).find(
        ([_, key]) => key === setting.key
      )?.[0] as AIFunctionType | undefined;

      if (functionType && (setting.value === "gemini" || setting.value === "openai")) {
        configured[functionType] = setting.value as "gemini" | "openai";
      }
    });

    return {
      available,
      configured
    };
  }
}
