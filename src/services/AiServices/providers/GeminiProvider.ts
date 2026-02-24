import axios from "axios";
import {
  IAIProvider,
  GenerateTextOptions,
  ChatMessage,
  ChatOptions,
  TranscribeAudioOptions
} from "../AIProviderInterface";
import {
  GEMINI_MODEL,
  GEMINI_BASE_URL,
  validateGeminiApiKey,
  interpretGeminiError
} from "../../../config/gemini";
import AppError from "../../../errors/AppError";
import { logger } from "../../../utils/logger";

/**
 * Provider Gemini implementando a interface IAIProvider
 * Wrapper do código Gemini existente
 */
export class GeminiProvider implements IAIProvider {
  readonly name = "gemini";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = validateGeminiApiKey(apiKey);
  }

  /**
   * Gera texto a partir de um prompt simples
   */
  async generateText(
    prompt: string,
    options: GenerateTextOptions = {}
  ): Promise<string> {
    const {
      temperature = 0.5,
      maxTokens = 2048,
      topP = 0.95
    } = options;

    try {
      const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent`;

      // Sanitizar prompt antes de enviar
      const sanitizedPrompt = (prompt || "")
        .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "") // Remover caracteres de controle inválidos
        .replace(/\uFFFD/g, "") // Remover caracteres de substituição Unicode
        .replace(/\u0000/g, "") // Remover null bytes
        .normalize("NFC"); // Normalizar Unicode

      const payload = {
        contents: [
          {
            parts: [
              {
                text: sanitizedPrompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature,
          topK: 40,
          topP,
          maxOutputTokens: maxTokens
        },
        safetySettings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_ONLY_HIGH"
          },
          {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_ONLY_HIGH"
          },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: "BLOCK_ONLY_HIGH"
          },
          {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: "BLOCK_ONLY_HIGH"
          }
        ]
      };

      const { data } = await axios.post(`${url}?key=${this.apiKey}`, payload, {
        timeout: 90000
      });

      const candidates = data?.candidates || [];
      
      if (candidates.length === 0) {
        throw new AppError("Conteúdo bloqueado pelos filtros de segurança", 400);
      }

      const first = candidates[0];
      
      // Verificar finishReason
      if (first?.finishReason && first.finishReason !== "STOP") {
        if (first.finishReason === "SAFETY") {
          throw new AppError("Conteúdo bloqueado pelos filtros de segurança", 400);
        }
        if (first.finishReason === "MAX_TOKENS") {
          // Continua para tentar extrair o que foi gerado
        }
      }

      const parts = first?.content?.parts || [];
      const text = parts
        .map((p: any) => p?.text || "")
        .filter((t: string) => t && typeof t === "string")
        .join("\n");

      if (!text || text.trim() === "") {
        throw new AppError("A IA não retornou resposta válida", 500);
      }

      // Sanitizar resposta: remover caracteres de controle inválidos e garantir encoding correto
      const sanitized = text
        .trim()
        .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "") // Remover caracteres de controle exceto \n, \r, \t
        .replace(/\uFFFD/g, "") // Remover caracteres de substituição Unicode
        .replace(/\u0000/g, "") // Remover null bytes
        .normalize("NFC"); // Normalizar Unicode mantendo acentos

      return sanitized.trim();
    } catch (err: any) {
      if (err instanceof AppError) {
        throw err;
      }
      
      const status = err.response?.status;
      const errorData = err.response?.data;
      
      if (status) {
        const userMessage = interpretGeminiError(status, errorData);
        throw new AppError(`Erro ao gerar texto com Gemini: ${userMessage}`, status);
      }
      
      throw new AppError(`Erro ao gerar texto com Gemini: ${err.message || "Erro desconhecido"}`, 500);
    }
  }

  /**
   * Realiza chat com histórico de mensagens
   */
  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {}
  ): Promise<string> {
    const {
      temperature = 0.5,
      maxTokens = 2048,
      topP = 0.95
    } = options;

    try {
      const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent`;

      // Converter mensagens para o formato Gemini, sanitizando o conteúdo
      const contents = messages.map(msg => {
        // Sanitizar conteúdo da mensagem antes de enviar
        const sanitizedContent = (msg.content || "")
          .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "") // Remover caracteres de controle inválidos
          .replace(/\uFFFD/g, "") // Remover caracteres de substituição Unicode
          .replace(/\u0000/g, "") // Remover null bytes
          .normalize("NFC"); // Normalizar Unicode
        
        return {
          role: msg.role === "system" ? "user" : msg.role === "user" ? "user" : "model",
          parts: [{ text: sanitizedContent }]
        };
      });

      const payload = {
        contents,
        generationConfig: {
          temperature,
          topK: 40,
          topP,
          maxOutputTokens: maxTokens
        },
        safetySettings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_ONLY_HIGH"
          },
          {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_ONLY_HIGH"
          },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: "BLOCK_ONLY_HIGH"
          },
          {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: "BLOCK_ONLY_HIGH"
          }
        ]
      };

      const { data } = await axios.post(`${url}?key=${this.apiKey}`, payload, {
        timeout: 90000
      });

      const candidates = data?.candidates || [];
      
      if (candidates.length === 0) {
        throw new AppError("Conteúdo bloqueado pelos filtros de segurança", 400);
      }

      const first = candidates[0];
      
      // Verificar finishReason
      if (first?.finishReason && first.finishReason !== "STOP") {
        if (first.finishReason === "SAFETY") {
          throw new AppError("Conteúdo bloqueado pelos filtros de segurança", 400);
        }
        if (first.finishReason === "MAX_TOKENS") {
          // Continua para tentar extrair o que foi gerado
        }
      }

      const parts = first?.content?.parts || [];
      const text = parts
        .map((p: any) => p?.text || "")
        .filter((t: string) => t && typeof t === "string")
        .join("\n");

      if (!text || text.trim() === "") {
        throw new AppError("A IA não retornou resposta válida", 500);
      }

      // Sanitizar resposta: remover caracteres de controle inválidos e garantir encoding correto
      const sanitized = text
        .trim()
        .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "") // Remover caracteres de controle exceto \n, \r, \t
        .replace(/\uFFFD/g, "") // Remover caracteres de substituição Unicode
        .replace(/\u0000/g, "") // Remover null bytes
        .normalize("NFC"); // Normalizar Unicode mantendo acentos

      return sanitized.trim();
    } catch (err: any) {
      if (err instanceof AppError) {
        throw err;
      }
      
      const status = err.response?.status;
      const errorData = err.response?.data;
      
      if (status) {
        const userMessage = interpretGeminiError(status, errorData);
        throw new AppError(`Erro ao realizar chat com Gemini: ${userMessage}`, status);
      }
      
      throw new AppError(`Erro ao realizar chat com Gemini: ${err.message || "Erro desconhecido"}`, 500);
    }
  }

  /**
   * Transcreve áudio para texto usando Gemini API
   * Aceita Buffer, FileStream ou caminho de arquivo
   */
  async transcribeAudio(
    audioInput: Buffer | any,
    mimeType: string,
    options: TranscribeAudioOptions = {}
  ): Promise<string> {
    try {
      const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent`;

      // Converter input para Buffer se necessário
      let audioBuffer: Buffer;
      if (Buffer.isBuffer(audioInput)) {
        audioBuffer = audioInput;
      } else if (typeof audioInput === "string") {
        // Se for caminho de arquivo
        const fs = require("fs");
        audioBuffer = fs.readFileSync(audioInput);
      } else {
        // Se for stream, precisamos ler para Buffer
        // Para Gemini, sempre usamos base64, então converter para Buffer primeiro
        const chunks: Buffer[] = [];
        for await (const chunk of audioInput) {
          chunks.push(Buffer.from(chunk));
        }
        audioBuffer = Buffer.concat(chunks);
      }

      // Converter buffer para base64
      const audioBase64 = audioBuffer.toString("base64");

      const payload = {
        contents: [
          {
            parts: [
              {
                // Prompt simplificado e direto para evitar que o modelo gaste tokens no processo de raciocínio
                // Gemini pode "pensar" demais se o prompt for muito complexo, deixando poucos tokens para a resposta
                text: options.prompt || "Transcreva o áudio. Apenas o texto transcrito."
              },
              {
                inlineData: {
                  mimeType: mimeType,
                  data: audioBase64
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1, // Baixa temperatura para transcrição mais precisa
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 4096, // Limite alto para garantir que há tokens suficientes para a resposta
          // Não usar stopSequences para transcrição - pode cortar a resposta
        },
        safetySettings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_ONLY_HIGH"
          },
          {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_ONLY_HIGH"
          },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: "BLOCK_ONLY_HIGH"
          },
          {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: "BLOCK_ONLY_HIGH"
          }
        ]
      };

      const { data } = await axios.post(`${url}?key=${this.apiKey}`, payload, {
        timeout: 120000 // 2 minutos para processar áudio
      });

      const candidates = data?.candidates || [];
      
      if (candidates.length === 0) {
        throw new AppError("Não foi possível transcrever o áudio. A API não retornou resultados.", 500);
      }

      const first = candidates[0];
      
      // Verificar finishReason
      if (first?.finishReason && first.finishReason !== "STOP") {
        if (first.finishReason === "SAFETY") {
          throw new AppError("Conteúdo bloqueado pelos filtros de segurança do Gemini.", 400);
        }
        if (first.finishReason === "MAX_TOKENS") {
          // Modelo atingiu limite de tokens - pode indicar que gastou muitos tokens "pensando"
          // Ainda assim, tentar extrair o que foi gerado
          logger.warn("Gemini atingiu MAX_TOKENS na transcrição - pode indicar prompt muito complexo ou áudio muito longo");
        }
      }

      const parts = first?.content?.parts || [];
      const transcription = parts
        .map((p: any) => p.text || "")
        .filter((t: string) => t.trim() !== "")
        .join("\n");

      if (!transcription || transcription.trim() === "") {
        // Verificar se finishReason foi MAX_TOKENS - indica que modelo gastou todos os tokens
        if (first?.finishReason === "MAX_TOKENS") {
          throw new AppError("ERR_AI_AUDIO_TOO_LONG", 400);
        }
        throw new AppError("ERR_AI_TRANSCRIPTION_EMPTY", 500);
      }

      return transcription.trim();
    } catch (err: any) {
      if (err instanceof AppError) {
        throw err;
      }
      
      const status = err.response?.status;
      const errorData = err.response?.data;
      
      if (status === 429) {
        throw new AppError("ERR_AI_QUOTA_EXCEEDED", 429);
      }
      if (status === 403 || (status === 400 && (errorData?.error?.message || "").includes("API_KEY"))) {
        throw new AppError("ERR_AI_CONFIG_MISSING", status);
      }
      if (status) {
        const userMessage = interpretGeminiError(status, errorData);
        throw new AppError(`ERR_AI_TRANSCRIPTION_ERROR: ${userMessage}`, status);
      }
      
      throw new AppError(`Erro ao transcrever áudio: ${err.message || "Erro desconhecido"}`, 500);
    }
  }
}
