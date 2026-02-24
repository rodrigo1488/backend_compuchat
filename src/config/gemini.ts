import axios from "axios";

// Configuração centralizada do Gemini
export const GEMINI_MODEL = "models/gemini-2.5-flash";
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1";

// Validação da chave da API
export const validateGeminiApiKey = (apiKey: string | null | undefined): string => {
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("Chave da API do Gemini não configurada. Configure GEMINI_API_KEY.");
  }
  return apiKey.trim();
};

// Interpretação de erros da API do Gemini
export const interpretGeminiError = (status: number, errorData?: any): string => {
  if (status === 403) {
    return "Chave da API inválida ou sem permissão no projeto Google Cloud.";
  }
  if (status === 404) {
    return "Modelo Gemini não encontrado. Verifique se está usando 'models/gemini-2.5-flash'.";
  }
  if (status === 429) {
    return "Limite de uso da API do Gemini atingido. Aguarde alguns minutos.";
  }
  if (status === 400) {
    const msg = errorData?.error?.message || "";
    if (msg.includes("API_KEY")) {
      return "Chave da API inválida. Verifique se a chave está correta.";
    }
    return `Requisição inválida: ${msg}`;
  }
  const errorMessage = errorData?.error?.message || "Erro desconhecido na API do Gemini";
  return `Erro na API do Gemini: ${errorMessage}`;
};

// Tratamento de erros da API do Gemini
export const handleGeminiError = (err: any): never => {
  const status = err.response?.status;
  if (status) {
    const userMessage = interpretGeminiError(status, err.response?.data);
    throw new Error(userMessage);
  }
  const errorMessage = err.message || "Erro desconhecido na API do Gemini";
  throw new Error(`Erro na API do Gemini: ${errorMessage}`);
};

// Teste automático da chave da API
export const testGeminiApiKey = async (apiKey: string): Promise<boolean> => {
  try {
    const response = await axios.post(
      `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        contents: [
          { parts: [{ text: "ping" }] }
        ]
      },
      {
        timeout: 10000
      }
    );
    return response.status === 200;
  } catch (err: any) {
    console.error("❌ Falha no teste da chave Gemini:", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });
    return false;
  }
};
