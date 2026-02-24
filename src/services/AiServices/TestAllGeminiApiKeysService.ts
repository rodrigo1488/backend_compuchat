import { Op } from "sequelize";
import { logger } from "../../utils/logger";
import Setting from "../../models/Setting";
import Company from "../../models/Company";
import TestGeminiApiKeyService from "./TestGeminiApiKeyService";

const TestAllGeminiApiKeysService = async (): Promise<void> => {
  try {
    logger.info("Iniciando teste automático das chaves da API do Gemini...");

    // Buscar todas as empresas que têm API key configurada
    const geminiSettings = await Setting.findAll({
      where: {
        key: "geminiApiKey"
      }
    });

    if (geminiSettings.length === 0) {
      logger.info("Nenhuma chave da API do Gemini configurada no sistema.");
      return;
    }

    logger.info(`Encontradas ${geminiSettings.length} chave(s) da API do Gemini para testar.`);

    // Buscar nomes das empresas
    const companyIds = geminiSettings.map(s => s.companyId);
    const companies = await Company.findAll({
      where: {
        id: { [Op.in]: companyIds }
      }
    });
    const companyMap = new Map(companies.map(c => [c.id, c.name]));

    const results = await Promise.allSettled(
      geminiSettings.map(async (setting) => {
        const companyId = setting.companyId;
        const companyName = companyMap.get(companyId) || `ID ${companyId}`;

        try {
          const result = await TestGeminiApiKeyService({ companyId });
          
          if (result.valid) {
            logger.info(`✅ Chave da API do Gemini válida para empresa: ${companyName} (ID: ${companyId})`);
          } else {
            logger.error(`❌ Chave da API do Gemini inválida para empresa: ${companyName} (ID: ${companyId}) - ${result.message}`);
          }
          
          return { companyId, companyName, ...result };
        } catch (err: any) {
          logger.error(`❌ Erro ao testar chave da API do Gemini para empresa: ${companyName} (ID: ${companyId}) - ${err.message}`);
          return { companyId, companyName, valid: false, message: err.message };
        }
      })
    );

    const validCount = results.filter(r => r.status === "fulfilled" && r.value.valid).length;
    const invalidCount = results.length - validCount;

    logger.info(`Teste automático concluído: ${validCount} válida(s), ${invalidCount} inválida(s).`);
  } catch (err: any) {
    logger.error(`Erro ao executar teste automático das chaves do Gemini: ${err.message}`);
  }
};

export default TestAllGeminiApiKeysService;

