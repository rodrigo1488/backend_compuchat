import axios from "axios";
import { GEMINI_MODEL, validateGeminiApiKey, interpretGeminiError } from "../../config/gemini";
import Setting from "../../models/Setting";

const GEMINI_API_BASES = [
  "https://generativelanguage.googleapis.com/v1",
  "https://generativelanguage.googleapis.com/v1beta"
];

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

  const body = {
    contents: [
      {
        parts: [
          {
            text: "Reply with the word OK only."
          }
        ]
      }
    ]
  };

  let lastErr: any = null;

  for (const base of GEMINI_API_BASES) {
    const url = `${base}/${GEMINI_MODEL}:generateContent`;
    try {
      const { status, data } = await axios.post(`${url}?key=${encodeURIComponent(apiKey)}`, body, {
        timeout: 15000,
        validateStatus: (s) => s < 500
      });

      if (status === 200) {
        // Não exigir texto: bloqueios de segurança podem retornar candidato vazio com chave válida
        return {
          valid: true,
          message: "Chave da API do Gemini válida e funcionando."
        };
      }

      if (status === 404) {
        lastErr = { response: { status, data } };
        continue;
      }

      const userMessage = interpretGeminiError(status, data);
      return {
        valid: false,
        message: userMessage
      };
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 404) {
        lastErr = err;
        continue;
      }
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
  }

  if (lastErr?.response?.status === 404) {
    return {
      valid: false,
      message:
        "Modelo Gemini não encontrado neste endpoint (v1/v1beta). Verifique se a chave tem acesso ao modelo configurado (ex.: gemini-2.5-flash) no Google AI Studio."
    };
  }

  return {
    valid: false,
    message: "Não foi possível validar a chave do Gemini. Tente novamente."
  };
};

export default TestGeminiApiKeyService;

