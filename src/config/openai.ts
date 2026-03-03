import { Configuration, OpenAIApi } from "openai";

// Configuração centralizada do OpenAI
export const OPENAI_DEFAULT_MODEL = "gpt-3.5-turbo";
export const OPENAI_TRANSCRIPTION_MODEL = "whisper-1";
export const OPENAI_VISION_MODEL = "gpt-4o-mini";

// Validação da chave da API
export const validateOpenAIApiKey = (apiKey: string | null | undefined): string => {
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("Chave da API do OpenAI não configurada. Configure OPENAI_API_KEY.");
  }
  
  // OpenAI API keys geralmente começam com "sk-"
  const trimmedKey = apiKey.trim();
  if (!trimmedKey.startsWith("sk-")) {
    throw new Error("Formato de chave da API do OpenAI inválido. A chave deve começar com 'sk-'.");
  }
  
  return trimmedKey;
};

// Interpretação de erros da API do OpenAI
export const interpretOpenAIError = (error: any): string => {
  if (error?.response?.status === 401) {
    return "Chave da API do OpenAI inválida ou expirada. Verifique se a chave está correta.";
  }
  if (error?.response?.status === 429) {
    const errorType = error?.response?.data?.error?.type;
    if (errorType === "insufficient_quota") {
      return "Limite de créditos da API do OpenAI atingido. Verifique seu saldo.";
    }
    if (errorType === "rate_limit_exceeded") {
      return "Limite de requisições da API do OpenAI atingido. Aguarde alguns minutos.";
    }
    return "Limite de uso da API do OpenAI atingido. Aguarde alguns minutos.";
  }
  if (error?.response?.status === 400) {
    const message = error?.response?.data?.error?.message || "";
    if (message.includes("model")) {
      return "Modelo OpenAI não encontrado ou não disponível. Verifique o modelo configurado.";
    }
    return `Requisição inválida: ${message}`;
  }
  if (error?.response?.status === 404) {
    return "Recurso da API do OpenAI não encontrado.";
  }
  if (error?.response?.status === 500 || error?.response?.status === 503) {
    return "Serviço da API do OpenAI temporariamente indisponível. Tente novamente em alguns instantes.";
  }
  
  const errorMessage = error?.response?.data?.error?.message || error?.message || "Erro desconhecido na API do OpenAI";
  return `Erro na API do OpenAI: ${errorMessage}`;
};

// Tratamento de erros da API do OpenAI
export const handleOpenAIError = (err: any): never => {
  const userMessage = interpretOpenAIError(err);
  throw new Error(userMessage);
};

// Criar cliente OpenAI (usando API antiga compatível com versão 3.3.0)
export const createOpenAIClient = (apiKey: string) => {
  const validatedKey = validateOpenAIApiKey(apiKey);
  const configuration = new Configuration({
    apiKey: validatedKey
  });
  return new OpenAIApi(configuration);
};

// Teste automático da chave da API
export const testOpenAIApiKey = async (apiKey: string): Promise<boolean> => {
  try {
    const client = createOpenAIClient(apiKey);
    
    // Fazer uma requisição simples para testar a chave (API antiga)
    await client.createChatCompletion({
      model: OPENAI_DEFAULT_MODEL,
      messages: [
        {
          role: "user",
          content: "ping"
        }
      ],
      max_tokens: 5
    });
    
    return true;
  } catch (err: any) {
    console.error("❌ Falha no teste da chave OpenAI:", {
      status: err?.response?.status,
      error: err?.response?.data?.error,
      message: err?.message
    });
    return false;
  }
};
