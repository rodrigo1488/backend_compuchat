import Setting from "../../models/Setting";
import { validateOpenAIApiKey, testOpenAIApiKey } from "../../config/openai";

interface TestOpenAIApiKeyParams {
  companyId: number;
}

interface TestOpenAIApiKeyResponse {
  valid: boolean;
  message: string;
}

const TestOpenAIApiKeyService = async ({
  companyId
}: TestOpenAIApiKeyParams): Promise<TestOpenAIApiKeyResponse> => {
  const openaiSetting = await Setting.findOne({
    where: {
      key: "openaiApiKey",
      companyId
    }
  });

  let apiKey: string;
  try {
    apiKey = validateOpenAIApiKey(openaiSetting?.value);
  } catch (err: any) {
    return {
      valid: false,
      message: err.message || "Chave da API do OpenAI não configurada."
    };
  }

  try {
    console.log(`🧪 Testando chave OpenAI...`);

    const testResult = await testOpenAIApiKey(apiKey);

    if (testResult.ok === false) {
      const hint = testResult.detail ? ` Detalhe da API: ${testResult.detail}` : "";
      return {
        valid: false,
        message: `Chave da API do OpenAI não passou no teste.${hint}. Verifique se a chave está ativa, não expirou e se há créditos/cota na conta.`
      };
    }

    console.log(`✅ Chave OpenAI válida e funcionando`);

    return {
      valid: true,
      message: "Chave da API do OpenAI válida e funcionando."
    };
  } catch (err: any) {
    console.error("❌ Erro ao testar OpenAI API Key:", {
      message: err.message
    });
    
    return {
      valid: false,
      message: `Erro ao testar conexão com a API do OpenAI: ${err.message || "Erro desconhecido"}`
    };
  }
};

export default TestOpenAIApiKeyService;
