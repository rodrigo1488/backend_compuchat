import axios from "axios";
import { GEMINI_MODEL, GEMINI_BASE_URL, validateGeminiApiKey, interpretGeminiError } from "../../config/gemini";
import Setting from "../../models/Setting";

interface TestGeminiApiKeyParams {
  companyId: number;
}

interface TestGeminiApiKeyResponse {
  valid: boolean;
  message: string;
}

const TestGeminiApiKeyService = async ({
  companyId
}: TestGeminiApiKeyParams): Promise<TestGeminiApiKeyResponse> => {
  const geminiSetting = await Setting.findOne({
    where: {
      key: "geminiApiKey",
      companyId
    }
  });

  let apiKey: string;
  try {
    apiKey = validateGeminiApiKey(geminiSetting?.value);
  } catch (err: any) {
    return {
      valid: false,
      message: err.message || "Chave da API do Gemini não configurada."
    };
  }

  try {
    const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent`;

    console.log(`🧪 Testando chave Gemini (${GEMINI_MODEL})...`);

    const { data } = await axios.post(
      `${url}?key=${apiKey}`,
      {
        contents: [
          {
            parts: [
              {
                text: "ping"
              }
            ]
          }
        ]
      },
      {
        timeout: 10000
      }
    );

    const candidates = data?.candidates || [];
    const first = candidates[0];
    const parts = first?.content?.parts || [];
    const text = parts.map((p: any) => p.text).join("\n");

    if (!text) {
      return {
        valid: false,
        message: "Resposta vazia do Gemini. Verifique a configuração da API."
      };
    }

    console.log(`✅ Chave Gemini válida e funcionando`);

    return {
      valid: true,
      message: "Chave da API do Gemini válida e funcionando."
    };
  } catch (err: any) {
    const status = err.response?.status;
    const errorData = err.response?.data;
    
    if (status) {
      const userMessage = interpretGeminiError(status, errorData);
      return {
        valid: false,
        message: userMessage
      };
    }
    
    return {
      valid: false,
      message: `Erro ao testar conexão com a API do Gemini: ${err.message || "Erro desconhecido"}`
    };
  }
};

export default TestGeminiApiKeyService;

