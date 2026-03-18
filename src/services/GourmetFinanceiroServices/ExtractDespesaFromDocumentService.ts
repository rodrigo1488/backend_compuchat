import axios from "axios";
import Setting from "../../models/Setting";
import AppError from "../../errors/AppError";
import { AIProviderFactory } from "../AiServices/AIProviderFactory";
import { GEMINI_BASE_URL, GEMINI_MODEL, validateGeminiApiKey } from "../../config/gemini";
import { createOpenAIClient, OPENAI_VISION_MODEL, validateOpenAIApiKey } from "../../config/openai";

const DESPESA_EXTRACTION_PROMPT = `Analise a imagem (foto/scan) de um documento de despesa (boleto, nota fiscal, recibo, fatura) e extraia as informações.

Responda APENAS com um JSON válido, sem explicação nem markdown, no formato exato:
{
  "descricao": "string curta (ex.: 'Conta de luz', 'Boleto Internet', 'NF Mercado')",
  "observacoes": "string opcional (pode ser vazia)",
  "valor": 123.45,
  "dataVencimento": "YYYY-MM-DD"
}

Regras:
- Use ponto para decimais (123.45).
- Se o documento tiver mais de um valor (ex.: total, juros, desconto), use o TOTAL a pagar.
- Se não encontrar data de vencimento, tente data de emissão; se mesmo assim não existir, use a data de hoje.
- Converta datas no formato brasileiro (DD/MM/AAAA) para YYYY-MM-DD.
- Se algum campo não estiver claro, estime a melhor opção sem inventar números absurdos.
`;

export type ExtractedDespesa = {
  descricao: string;
  observacoes: string;
  valor: number;
  dataVencimento: string; // YYYY-MM-DD
};

function extractJsonFromResponse(raw: string): string {
  let text = raw.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    text = jsonMatch[1].trim();
  }
  return text;
}

function todayISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function parseAndValidate(rawJson: string): ExtractedDespesa {
  const parsed = JSON.parse(rawJson) as any;

  const descricao = typeof parsed.descricao === "string" ? parsed.descricao.trim() : "";
  const observacoes = typeof parsed.observacoes === "string" ? parsed.observacoes.trim() : "";

  let valor = 0;
  if (typeof parsed.valor === "number") valor = parsed.valor;
  else if (typeof parsed.valor === "string") {
    const n = parseFloat(parsed.valor.replace(/\./g, "").replace(",", "."));
    if (!isNaN(n)) valor = n;
  }
  if (!Number.isFinite(valor) || valor < 0) valor = 0;

  let dataVencimento = typeof parsed.dataVencimento === "string" ? parsed.dataVencimento.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataVencimento)) {
    // tentar converter DD/MM/AAAA
    const m = dataVencimento.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) dataVencimento = `${m[3]}-${m[2]}-${m[1]}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataVencimento)) {
    dataVencimento = todayISO();
  }

  return {
    descricao: descricao || "Despesa",
    observacoes,
    valor: Math.round(valor * 100) / 100,
    dataVencimento,
  };
}

async function extractWithGemini(apiKey: string, fileBase64: string, mimeType: string): Promise<string> {
  const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent`;
  const payload = {
    contents: [
      {
        parts: [
          { text: DESPESA_EXTRACTION_PROMPT },
          { inlineData: { mimeType, data: fileBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048,
    },
  };

  const { data } = await axios.post(`${url}?key=${apiKey}`, payload, { timeout: 60000 });
  const candidates = data?.candidates || [];
  const parts = candidates?.[0]?.content?.parts || [];
  const text = parts
    .map((p: any) => p?.text || "")
    .filter((t: any) => typeof t === "string" && t.trim())
    .join("\n")
    .trim();

  if (!text) throw new AppError("Não foi possível extrair a despesa. Tente outra imagem.", 400);
  return text;
}

async function extractWithOpenAI(apiKey: string, fileBase64: string, mimeType: string): Promise<string> {
  const client = createOpenAIClient(apiKey);
  const dataUrl = `data:${mimeType};base64,${fileBase64}`;

  const completion = await client.createChatCompletion({
    model: OPENAI_VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: DESPESA_EXTRACTION_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ] as any,
      },
    ],
    max_tokens: 1024,
    temperature: 0.2,
  });

  const text = completion.data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new AppError("Não foi possível extrair a despesa. Tente outra imagem.", 400);
  return text;
}

export default async function ExtractDespesaFromDocumentService(params: {
  companyId: number;
  fileBase64: string;
  mimeType: string;
}): Promise<ExtractedDespesa> {
  const { companyId, fileBase64, mimeType } = params;

  const providers = await AIProviderFactory.getAvailableProviders(companyId);
  let rawResponse: string;

  if (providers.gemini) {
    const geminiSetting = await Setting.findOne({ where: { key: "geminiApiKey", companyId } });
    const apiKey = validateGeminiApiKey(geminiSetting?.value);
    rawResponse = await extractWithGemini(apiKey, fileBase64, mimeType);
  } else if (providers.openai) {
    const openaiSetting = await Setting.findOne({ where: { key: "openaiApiKey", companyId } });
    const apiKey = validateOpenAIApiKey(openaiSetting?.value);
    rawResponse = await extractWithOpenAI(apiKey, fileBase64, mimeType);
  } else {
    throw new AppError(
      "Configure a chave da API do Gemini ou da OpenAI em Configurações → Integrações para extrair a despesa pela IA.",
      400
    );
  }

  const jsonStr = extractJsonFromResponse(rawResponse);
  try {
    return parseAndValidate(jsonStr);
  } catch {
    throw new AppError("Não foi possível extrair os dados da despesa. Tente uma imagem mais nítida.", 400);
  }
}

