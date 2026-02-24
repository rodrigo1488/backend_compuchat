import Setting from "../../models/Setting";
import { logger } from "../../utils/logger";

export interface ChatConfig {
  temperature: number;
  maxHistoryMessages: number;
  maxTokens: number;
  topP: number;
}

const DEFAULT_CONFIG: ChatConfig = {
  temperature: 0.3,
  maxHistoryMessages: 10,
  maxTokens: 4096,
  topP: 0.95
};

/**
 * Busca configurações do chat IA para uma empresa
 */
export const getChatConfig = async (companyId: number): Promise<ChatConfig> => {
  try {
    const [temperatureSetting, maxHistorySetting, maxTokensSetting, topPSetting] = await Promise.all([
      Setting.findOne({ where: { key: "aiChatTemperature", companyId } }),
      Setting.findOne({ where: { key: "aiChatMaxHistoryMessages", companyId } }),
      Setting.findOne({ where: { key: "aiChatMaxTokens", companyId } }),
      Setting.findOne({ where: { key: "aiChatTopP", companyId } })
    ]);

    const config: ChatConfig = {
      temperature: temperatureSetting ? parseFloat(temperatureSetting.value) : DEFAULT_CONFIG.temperature,
      maxHistoryMessages: maxHistorySetting ? parseInt(maxHistorySetting.value, 10) : DEFAULT_CONFIG.maxHistoryMessages,
      maxTokens: maxTokensSetting ? parseInt(maxTokensSetting.value, 10) : DEFAULT_CONFIG.maxTokens,
      topP: topPSetting ? parseFloat(topPSetting.value) : DEFAULT_CONFIG.topP
    };

    // Validações
    if (config.temperature < 0 || config.temperature > 2) {
      logger.warn(`Temperatura inválida (${config.temperature}), usando padrão: ${DEFAULT_CONFIG.temperature}`);
      config.temperature = DEFAULT_CONFIG.temperature;
    }

    if (config.maxHistoryMessages < 0 || config.maxHistoryMessages > 100) {
      logger.warn(`MaxHistoryMessages inválido (${config.maxHistoryMessages}), usando padrão: ${DEFAULT_CONFIG.maxHistoryMessages}`);
      config.maxHistoryMessages = DEFAULT_CONFIG.maxHistoryMessages;
    }

    if (config.maxTokens < 100 || config.maxTokens > 32000) {
      logger.warn(`MaxTokens inválido (${config.maxTokens}), usando padrão: ${DEFAULT_CONFIG.maxTokens}`);
      config.maxTokens = DEFAULT_CONFIG.maxTokens;
    }

    if (config.topP < 0 || config.topP > 1) {
      logger.warn(`TopP inválido (${config.topP}), usando padrão: ${DEFAULT_CONFIG.topP}`);
      config.topP = DEFAULT_CONFIG.topP;
    }

    return config;
  } catch (err: any) {
    logger.error(`Erro ao buscar configurações do chat IA: ${err.message}`);
    return DEFAULT_CONFIG;
  }
};

/**
 * Salva configurações do chat IA para uma empresa
 */
export const saveChatConfig = async (
  companyId: number,
  config: Partial<ChatConfig>
): Promise<ChatConfig> => {
  try {
    // Validações antes de salvar
    if (config.temperature !== undefined) {
      if (config.temperature < 0 || config.temperature > 2) {
        throw new Error("Temperatura deve estar entre 0 e 2");
      }
    }

    if (config.maxHistoryMessages !== undefined) {
      if (config.maxHistoryMessages < 0 || config.maxHistoryMessages > 100) {
        throw new Error("MaxHistoryMessages deve estar entre 0 e 100");
      }
    }

    if (config.maxTokens !== undefined) {
      if (config.maxTokens < 100 || config.maxTokens > 32000) {
        throw new Error("MaxTokens deve estar entre 100 e 32000");
      }
    }

    if (config.topP !== undefined) {
      if (config.topP < 0 || config.topP > 1) {
        throw new Error("TopP deve estar entre 0 e 1");
      }
    }

    // Salvar cada configuração
    const updates: Promise<any>[] = [];

    if (config.temperature !== undefined) {
      updates.push(
        (async () => {
          const [setting] = await Setting.findOrCreate({
            where: { key: "aiChatTemperature", companyId },
            defaults: { key: "aiChatTemperature", value: config.temperature.toString(), companyId }
          });
          return setting.update({ value: config.temperature!.toString() });
        })()
      );
    }

    if (config.maxHistoryMessages !== undefined) {
      updates.push(
        (async () => {
          const [setting] = await Setting.findOrCreate({
            where: { key: "aiChatMaxHistoryMessages", companyId },
            defaults: { key: "aiChatMaxHistoryMessages", value: config.maxHistoryMessages.toString(), companyId }
          });
          return setting.update({ value: config.maxHistoryMessages!.toString() });
        })()
      );
    }

    if (config.maxTokens !== undefined) {
      updates.push(
        (async () => {
          const [setting] = await Setting.findOrCreate({
            where: { key: "aiChatMaxTokens", companyId },
            defaults: { key: "aiChatMaxTokens", value: config.maxTokens.toString(), companyId }
          });
          return setting.update({ value: config.maxTokens!.toString() });
        })()
      );
    }

    if (config.topP !== undefined) {
      updates.push(
        (async () => {
          const [setting] = await Setting.findOrCreate({
            where: { key: "aiChatTopP", companyId },
            defaults: { key: "aiChatTopP", value: config.topP.toString(), companyId }
          });
          return setting.update({ value: config.topP!.toString() });
        })()
      );
    }

    await Promise.all(updates);

    // Retornar configuração atualizada
    return await getChatConfig(companyId);
  } catch (err: any) {
    logger.error(`Erro ao salvar configurações do chat IA: ${err.message}`);
    throw err;
  }
};
