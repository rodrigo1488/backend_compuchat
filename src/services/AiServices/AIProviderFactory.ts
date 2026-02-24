import Setting from "../../models/Setting";
import { IAIProvider } from "./AIProviderInterface";
import { OpenAIProvider } from "./providers/OpenAIProvider";
import { GeminiProvider } from "./providers/GeminiProvider";
import { validateGeminiApiKey } from "../../config/gemini";
import { validateOpenAIApiKey } from "../../config/openai";
import AppError from "../../errors/AppError";

/**
 * Factory para criar instâncias de providers de IA
 */
export class AIProviderFactory {
  /**
   * Cria uma instância do provider especificado
   */
  static createProvider(
    providerName: "gemini" | "openai",
    apiKey: string
  ): IAIProvider {
    switch (providerName) {
      case "gemini":
        return new GeminiProvider(apiKey);
      case "openai":
        return new OpenAIProvider(apiKey);
      default:
        throw new AppError(`Provider não suportado: ${providerName}`, 400);
    }
  }

  /**
   * Cria uma instância do provider Gemini a partir das Settings da empresa
   */
  static async createGeminiProvider(companyId: number): Promise<GeminiProvider> {
    const geminiSetting = await Setting.findOne({
      where: {
        key: "geminiApiKey",
        companyId
      }
    });

    try {
      const apiKey = validateGeminiApiKey(geminiSetting?.value);
      return new GeminiProvider(apiKey);
    } catch (err: any) {
      throw new AppError(
        "A API Key do Gemini não está configurada. Configure em Configurações → Integrações → Chave da API do Gemini.",
        400
      );
    }
  }

  /**
   * Cria uma instância do provider OpenAI a partir das Settings da empresa
   */
  static async createOpenAIProvider(companyId: number): Promise<OpenAIProvider> {
    const openaiSetting = await Setting.findOne({
      where: {
        key: "openaiApiKey",
        companyId
      }
    });

    try {
      const apiKey = validateOpenAIApiKey(openaiSetting?.value);
      return new OpenAIProvider(apiKey);
    } catch (err: any) {
      throw new AppError(
        "A API Key do OpenAI não está configurada. Configure em Configurações → Integrações → Chave da API do OpenAI.",
        400
      );
    }
  }

  /**
   * Verifica quais providers estão configurados para a empresa
   */
  static async getAvailableProviders(companyId: number): Promise<{
    gemini: boolean;
    openai: boolean;
  }> {
    const [geminiSetting, openaiSetting] = await Promise.all([
      Setting.findOne({
        where: {
          key: "geminiApiKey",
          companyId
        }
      }),
      Setting.findOne({
        where: {
          key: "openaiApiKey",
          companyId
        }
      })
    ]);

    let geminiAvailable = false;
    let openaiAvailable = false;

    try {
      if (geminiSetting?.value) {
        validateGeminiApiKey(geminiSetting.value);
        geminiAvailable = true;
      }
    } catch {
      // Gemini não disponível
    }

    try {
      if (openaiSetting?.value) {
        validateOpenAIApiKey(openaiSetting.value);
        openaiAvailable = true;
      }
    } catch {
      // OpenAI não disponível
    }

    return {
      gemini: geminiAvailable,
      openai: openaiAvailable
    };
  }
}
