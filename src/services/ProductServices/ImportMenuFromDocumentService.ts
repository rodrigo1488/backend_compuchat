import fs from "fs";
import path from "path";
import axios from "axios";
import { PDFDocument } from "pdf-lib";
import Setting from "../../models/Setting";
import AppError from "../../errors/AppError";
import { AIProviderFactory } from "../AiServices/AIProviderFactory";
import {
  GEMINI_MODEL,
  GEMINI_BASE_URL,
  validateGeminiApiKey,
} from "../../config/gemini";
import {
  createOpenAIClient,
  OPENAI_VISION_MODEL,
  validateOpenAIApiKey,
} from "../../config/openai";
import { logger } from "../../utils/logger";

const MENU_EXTRACTION_PROMPT = `Analise este cardápio (imagem ou PDF) e extraia:

1) PRODUTOS PRINCIPAIS: itens que o cliente pede como prato principal (lanches, bebidas, pratos, pizzas, etc.). Para cada um: nome, grupo/categoria (ex.: Bebidas, Lanches), valor em reais e descrição se houver.

2) ADICIONAIS (COMPLEMENTOS/EXTRAS): itens que são acrescidos ao produto (ex.: bacon, queijo extra, açúcar, leite, tamanho P/M/G, borda recheada). NÃO são produtos principais. Agrupe os adicionais em "grupos de adicionais": cada grupo tem um nome (ex.: "Adicionais para Lanches", "Açúcar e Leite"), uma lista de itens (label e valor em R$) e os grupos de produto aos quais se aplicam (gruposProduto).

Responda APENAS com um JSON válido, sem explicação nem markdown, no formato exato:
{
  "grupos": ["Bebidas","Lanches"],
  "produtos": [
    {"nome": "X-Burger", "descricao": "opcional", "grupo": "Lanches", "valor": 18.90}
  ],
  "adicionais": [
    {
      "nomeGrupo": "Adicionais para Lanches",
      "itens": [
        {"label": "Bacon", "valor": 2.00},
        {"label": "Queijo extra", "valor": 1.50}
      ],
      "gruposProduto": ["Lanches"]
    },
    {
      "nomeGrupo": "Açúcar e Leite",
      "itens": [
        {"label": "Açúcar", "valor": 0},
        {"label": "Leite", "valor": 0}
      ],
      "gruposProduto": ["Bebidas"]
    }
  ]
}
Use ponto para decimais. Se não identificar grupo para um produto, use "Outros". "adicionais" pode ser array vazio [] se não houver adicionais no cardápio. Cada item em itens deve ter "label" (texto) e "valor" (número >= 0).`;

export interface ImportMenuProductItem {
  nome: string;
  descricao?: string;
  grupo: string;
  valor: number;
}

export interface ImportMenuAdicionalItem {
  label: string;
  valor: number;
}

export interface ImportMenuAdicionalGroup {
  nomeGrupo: string;
  itens: ImportMenuAdicionalItem[];
  gruposProduto: string[];
}

export interface ImportMenuPreview {
  grupos: string[];
  produtos: ImportMenuProductItem[];
  adicionais: ImportMenuAdicionalGroup[];
  /** Indica que o resultado é parcial (ex.: erro em alguma página do PDF) */
  partial?: boolean;
  /** Páginas processadas com sucesso (apenas para PDF) */
  processedPages?: number;
  /** Total de páginas do PDF */
  totalPages?: number;
  /** Mensagens de erro por página (ex.: "Página 3: timeout") */
  pageErrors?: string[];
}

interface Request {
  companyId: number;
  filePath: string;
  mimeType: string;
  /** Chamado a cada página extraída (apenas PDF). Útil para streaming de progresso. */
  onPageExtracted?: (page: number, total: number) => void | Promise<void>;
}

function extractJsonFromResponse(raw: string): string {
  let text = raw.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    text = jsonMatch[1].trim();
  }
  return text;
}

/** Junta dois previews (grupos união, produtos concatena, adicionais por nomeGrupo). */
function mergePreview(a: ImportMenuPreview, b: ImportMenuPreview): ImportMenuPreview {
  const grupos = [...new Set([...a.grupos, ...b.grupos])].sort();
  const produtos = [...a.produtos, ...b.produtos];
  const byNome = new Map<string, ImportMenuAdicionalGroup>();
  for (const g of [...(a.adicionais ?? []), ...(b.adicionais ?? [])]) {
    const key = (g.nomeGrupo || "").trim();
    if (!key) continue;
    const existing = byNome.get(key);
    if (!existing) {
      byNome.set(key, { nomeGrupo: key, itens: [...g.itens], gruposProduto: [...(g.gruposProduto || [])] });
    } else {
      const existingLabels = new Set(existing.itens.map((i) => i.label));
      for (const it of g.itens || []) {
        if (it.label && !existingLabels.has(it.label)) {
          existing.itens.push(it);
          existingLabels.add(it.label);
        }
      }
      existing.gruposProduto = [...new Set([...existing.gruposProduto, ...(g.gruposProduto || [])])];
    }
  }
  const adicionais = Array.from(byNome.values());
  return {
    grupos,
    produtos,
    adicionais,
    partial: a.partial || b.partial,
    processedPages: a.processedPages,
    totalPages: a.totalPages,
    pageErrors: [...(a.pageErrors ?? []), ...(b.pageErrors ?? [])],
  };
}

/**
 * Divide um PDF em buffers, um por página (PDF de uma página cada).
 */
async function splitPdfIntoPages(pdfBuffer: Buffer): Promise<Buffer[]> {
  const sourceDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pageCount = sourceDoc.getPageCount();
  const pages: Buffer[] = [];
  for (let i = 0; i < pageCount; i++) {
    const newDoc = await PDFDocument.create();
    const [copiedPage] = await newDoc.copyPages(sourceDoc, [i]);
    newDoc.addPage(copiedPage);
    const bytes = await newDoc.save();
    pages.push(Buffer.from(bytes));
  }
  return pages;
}

function parseAndValidatePreview(rawJson: string): ImportMenuPreview {
  const parsed = JSON.parse(rawJson) as {
    grupos?: string[];
    produtos?: Array<{
      nome?: string;
      descricao?: string;
      grupo?: string;
      valor?: number | string;
    }>;
    adicionais?: Array<{
      nomeGrupo?: string;
      itens?: Array<{ label?: string; valor?: number | string }>;
      gruposProduto?: string[];
    }>;
  };

  const grupos: string[] = Array.isArray(parsed.grupos)
    ? parsed.grupos.filter((g) => typeof g === "string")
    : [];
  const produtos: ImportMenuProductItem[] = [];
  const adicionais: ImportMenuAdicionalGroup[] = [];

  if (Array.isArray(parsed.produtos)) {
    for (const p of parsed.produtos) {
      const nome =
        typeof p.nome === "string" && p.nome.trim() ? p.nome.trim() : null;
      if (!nome) continue;

      let valor = 0;
      if (typeof p.valor === "number" && p.valor >= 0) {
        valor = p.valor;
      } else if (typeof p.valor === "string") {
        const n = parseFloat(p.valor.replace(",", "."));
        if (!isNaN(n) && n >= 0) valor = n;
      }

      const grupo =
        typeof p.grupo === "string" && p.grupo.trim()
          ? p.grupo.trim()
          : "Outros";
      const descricao =
        typeof p.descricao === "string" ? p.descricao.trim() || undefined : undefined;

      produtos.push({ nome, descricao, grupo, valor });
    }
  }

  if (Array.isArray(parsed.adicionais)) {
    for (const ad of parsed.adicionais) {
      const nomeGrupo = typeof ad.nomeGrupo === "string" && ad.nomeGrupo.trim() ? ad.nomeGrupo.trim() : null;
      if (!nomeGrupo) continue;
      const itens: ImportMenuAdicionalItem[] = [];
      for (const it of ad.itens || []) {
        const label = typeof it.label === "string" && it.label.trim() ? it.label.trim() : null;
        if (!label) continue;
        let val = 0;
        if (typeof it.valor === "number" && it.valor >= 0) val = it.valor;
        else if (typeof it.valor === "string") {
          const n = parseFloat(it.valor.replace(",", "."));
          if (!isNaN(n) && n >= 0) val = n;
        }
        itens.push({ label, valor: val });
      }
      const gruposProduto = Array.isArray(ad.gruposProduto)
        ? ad.gruposProduto.filter((g) => typeof g === "string").map((g) => g.trim()).filter(Boolean)
        : [];
      if (itens.length > 0) {
        adicionais.push({ nomeGrupo, itens, gruposProduto });
      }
    }
  }

  const uniqueGrupos = [...new Set([...grupos, ...produtos.map((p) => p.grupo)])].sort();
  return { grupos: uniqueGrupos, produtos, adicionais };
}

async function extractWithGemini(
  apiKey: string,
  fileBase64: string,
  mimeType: string
): Promise<string> {
  const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent`;
  const payload = {
    contents: [
      {
        parts: [
          { text: MENU_EXTRACTION_PROMPT },
          {
            inlineData: {
              mimeType,
              data: fileBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 8192,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  const { data } = await axios.post(`${url}?key=${apiKey}`, payload, {
    timeout: 120000,
  });

  const candidates = data?.candidates || [];
  if (candidates.length === 0) {
    throw new AppError(
      "Não foi possível extrair o cardápio. A IA não retornou resultado.",
      400
    );
  }

  const parts = candidates[0]?.content?.parts || [];
  const text = parts
    .map((p: { text?: string }) => p?.text || "")
    .filter((t: string) => t && typeof t === "string")
    .join("\n");

  if (!text || !text.trim()) {
    throw new AppError(
      "Não foi possível extrair o cardápio. Tente outra imagem ou PDF.",
      400
    );
  }
  return text.trim();
}

async function extractWithOpenAI(
  apiKey: string,
  fileBase64: string,
  mimeType: string
): Promise<string> {
  const client = createOpenAIClient(apiKey);
  const dataUrl = `data:${mimeType};base64,${fileBase64}`;

  const completion = await client.createChatCompletion({
    model: OPENAI_VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: MENU_EXTRACTION_PROMPT },
          {
            type: "image_url",
            image_url: { url: dataUrl },
          },
        ] as any,
      },
    ],
    max_tokens: 4096,
    temperature: 0.2,
  });

  const text =
    completion.data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new AppError(
      "Não foi possível extrair o cardápio. Tente outra imagem ou PDF.",
      400
    );
  }
  return text;
}

const ImportMenuFromDocumentService = async ({
  companyId,
  filePath,
  mimeType,
  onPageExtracted,
}: Request): Promise<ImportMenuPreview> => {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (!fs.existsSync(fullPath)) {
    throw new AppError("Arquivo não encontrado.", 400);
  }

  const buffer = fs.readFileSync(fullPath);
  const fileBase64 = buffer.toString("base64");

  const providers = await AIProviderFactory.getAvailableProviders(companyId);
  const isPdf = mimeType === "application/pdf";

  let rawResponse: string;

  if (isPdf) {
    if (!providers.gemini) {
      throw new AppError(
        "Para importar PDF, configure a chave da API do Gemini em Configurações → Integrações.",
        400
      );
    }
    const geminiSetting = await Setting.findOne({
      where: { key: "geminiApiKey", companyId },
    });
    const apiKey = validateGeminiApiKey(geminiSetting?.value);

    const pdfBuffer = Buffer.from(buffer);
    let pages: Buffer[];
    try {
      pages = await splitPdfIntoPages(pdfBuffer);
    } catch (err: any) {
      logger.error("Erro ao dividir PDF em páginas: %s", err?.message);
      throw new AppError("Não foi possível ler o PDF. Verifique se o arquivo está correto.", 400);
    }

    const totalPages = pages.length;
    if (totalPages === 0) {
      throw new AppError("O PDF não contém páginas.", 400);
    }

    let accumulated: ImportMenuPreview = {
      grupos: [],
      produtos: [],
      adicionais: [],
      processedPages: 0,
      totalPages,
    };
    const pageErrors: string[] = [];

    for (let i = 0; i < pages.length; i++) {
      const pageNum = i + 1;
      const pageBase64 = pages[i].toString("base64");
      try {
        rawResponse = await extractWithGemini(apiKey, pageBase64, "application/pdf");
        const jsonStr = extractJsonFromResponse(rawResponse);
        const pagePreview = parseAndValidatePreview(jsonStr);
        accumulated = mergePreview(accumulated, pagePreview);
        accumulated.processedPages = (accumulated.processedPages ?? 0) + 1;
        accumulated.totalPages = totalPages;
        if (onPageExtracted) {
          await Promise.resolve(onPageExtracted(pageNum, totalPages));
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        pageErrors.push(`Página ${pageNum}: ${msg}`);
        logger.warn("Importação cardápio: falha na página %d/%d: %s", pageNum, totalPages, msg);
      }
    }

    if (pageErrors.length > 0) {
      accumulated.partial = true;
      accumulated.pageErrors = pageErrors;
    }
    if (accumulated.produtos.length === 0 && accumulated.grupos.length === 0) {
      throw new AppError(
        "Não foi possível extrair produtos de nenhuma página. " +
          (pageErrors.length > 0 ? pageErrors.join(" ") : "Tente outro arquivo."),
        400
      );
    }
    return accumulated;
  } else {
    if (providers.gemini) {
      const geminiSetting = await Setting.findOne({
        where: { key: "geminiApiKey", companyId },
      });
      const apiKey = validateGeminiApiKey(geminiSetting?.value);
      rawResponse = await extractWithGemini(apiKey, fileBase64, mimeType);
    } else if (providers.openai) {
      const openaiSetting = await Setting.findOne({
        where: { key: "openaiApiKey", companyId },
      });
      const apiKey = validateOpenAIApiKey(openaiSetting?.value);
      rawResponse = await extractWithOpenAI(apiKey, fileBase64, mimeType);
    } else {
      throw new AppError(
        "Configure a chave da API do Gemini ou da OpenAI em Configurações → Integrações para importar do cardápio.",
        400
      );
    }
  }

  const jsonStr = extractJsonFromResponse(rawResponse);
  try {
    return parseAndValidatePreview(jsonStr);
  } catch {
    throw new AppError(
      "Não foi possível extrair o cardápio. Verifique se o arquivo contém um cardápio legível e tente novamente.",
      400
    );
  }
};

export default ImportMenuFromDocumentService;
