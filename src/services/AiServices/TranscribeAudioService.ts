import fs from "fs";
import path from "path";
import AppError from "../../errors/AppError";
import Message from "../../models/Message";
import { AIProviderSelector } from "./AIProviderSelector";
import { logger } from "../../utils/logger";

interface TranscribeAudioParams {
  messageId: string;
  companyId: number;
}

interface TranscribeAudioResponse {
  transcription: string;
  messageId: string;
}

const publicFolder = path.resolve(__dirname, "..", "..", "..", "public");

/**
 * Converte arquivo de áudio para base64
 */
const audioToBase64 = (filePath: string): string => {
  const fileBuffer = fs.readFileSync(filePath);
  return fileBuffer.toString("base64");
};

/**
 * Detecta o tipo MIME do arquivo de áudio baseado na extensão
 */
const getAudioMimeType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: { [key: string]: string } = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/m4a",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".aac": "audio/aac"
  };
  return mimeTypes[ext] || "audio/mpeg";
};

/**
 * Valida o tamanho do arquivo (máximo 100MB)
 */
const validateFileSize = (filePath: string): void => {
  const stats = fs.statSync(filePath);
  const fileSizeInMB = stats.size / (1024 * 1024);
  
  if (fileSizeInMB > 100) {
    throw new AppError(
      `Arquivo de áudio muito grande (${fileSizeInMB.toFixed(2)}MB). O tamanho máximo é 100MB.`,
      400
    );
  }
};

/**
 * Transcreve mensagem de áudio usando Gemini API
 */
const transcribeAudio = async ({
  messageId,
  companyId
}: TranscribeAudioParams): Promise<TranscribeAudioResponse> => {
  let providerName = "IA";
  
  try {
    // Buscar mensagem
    const message = await Message.findOne({
      where: {
        id: messageId,
        companyId,
        mediaType: "audio",
        isDeleted: false
      }
    });

    if (!message) {
      throw new AppError("Mensagem de áudio não encontrada ou não pertence a esta empresa.", 404);
    }

    // Selecionar provider usando configuração automática
    const provider = await AIProviderSelector.getProvider(companyId, "transcription");
    providerName = provider.name;
    
    // Obter caminho do arquivo de áudio
    // O mediaUrl retorna a URL completa, mas precisamos do nome do arquivo
    const mediaUrlValue = message.getDataValue("mediaUrl");
    if (!mediaUrlValue) {
      throw new AppError("Arquivo de áudio não encontrado para esta mensagem.", 404);
    }

    // Extrair nome do arquivo da URL
    const fileName = mediaUrlValue.includes("/public/")
      ? mediaUrlValue.split("/public/")[1]
      : mediaUrlValue.split("/").pop() || mediaUrlValue;

    const audioFilePath = path.join(publicFolder, fileName);

    // Verificar se arquivo existe
    if (!fs.existsSync(audioFilePath)) {
      logger.error(`Arquivo de áudio não encontrado: ${audioFilePath}`);
      throw new AppError("Arquivo de áudio não encontrado no servidor.", 404);
    }

    // Validar tamanho do arquivo
    validateFileSize(audioFilePath);

    // Obter tipo MIME do áudio
    const mimeType = getAudioMimeType(audioFilePath);

    // Ler arquivo de áudio
    logger.info(`Lendo arquivo de áudio para transcrição: ${audioFilePath}`);
    const audioBuffer = fs.readFileSync(audioFilePath);

    // Chamar provider para transcrever
    logger.info(`Enviando áudio para transcrição usando ${providerName} (tamanho: ${(audioBuffer.length / 1024).toFixed(2)}KB)`);
    
    // Prompt simplificado e direto para evitar que o modelo gaste tokens desnecessariamente
    // O prompt do Whisper deve ser curto e direto - apenas contexto sobre o que esperar no áudio
    const transcription = await provider.transcribeAudio(
      audioBuffer,
      mimeType,
      {
        // Prompt mínimo - apenas para contexto, não para instruções complexas
        // Whisper funciona melhor com prompts curtos que descrevem o contexto do áudio
        prompt: undefined // Remover prompt para evitar problemas - Whisper funciona melhor sem prompt complexo
      }
    );

    if (!transcription || transcription.trim() === "") {
      logger.error(`Transcrição vazia retornada pelo ${providerName}`);
      throw new AppError("ERR_AI_TRANSCRIPTION_EMPTY", 500);
    }

    logger.info(`✅ Transcrição concluída com sucesso usando ${providerName} (${transcription.length} caracteres)`);

    return {
      transcription: transcription.trim(),
      messageId
    };
  } catch (err: any) {
    if (err instanceof AppError) {
      throw err;
    }

    logger.error(`Erro ao transcrever áudio com ${providerName}:`, {
      message: err.message,
      messageId,
      companyId
    });

    if (err instanceof AppError) {
      throw err;
    }

    throw new AppError(
      `Erro ao transcrever áudio: ${err.message || "Erro desconhecido"}`,
      500
    );
  }
};

export default transcribeAudio;

