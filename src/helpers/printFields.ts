import {
  isPieceAgainFieldStored,
  isPieceAgainStorableField,
  listPieceAgainStorableFields,
} from "./pieceAgainFields";

type FormFieldLike = {
  id?: number;
  label?: string;
  order?: number;
  fieldType?: string;
  metadata?: { isAutoField?: boolean; autoFieldType?: string } | null;
};

type PrintAnswer = {
  fieldId?: number;
  label?: string;
  answer?: unknown;
};

export const isPrintStorableField = isPieceAgainStorableField;
export const listPrintStorableFields = listPieceAgainStorableFields;

export const resolvePrintStoredFieldIds = (
  settings: { printStoredFieldIds?: number[] } | null | undefined,
  fields: FormFieldLike[] = []
): number[] => {
  const storable = listPrintStorableFields(fields);
  const storableIds = new Set(storable.map((f) => Number(f.id)));

  const configured = settings?.printStoredFieldIds;
  if (!Array.isArray(configured)) {
    return storable.map((f) => Number(f.id));
  }
  if (configured.length === 0) {
    return [];
  }
  return configured
    .map((id) => Number(id))
    .filter((id) => id > 0 && storableIds.has(id));
};

export const filterAnswersForPrint = (
  answers: PrintAnswer[],
  fields: FormFieldLike[],
  storedFieldIds: number[]
): PrintAnswer[] =>
  (answers || []).filter((answer) => {
    const fieldId = Number(answer.fieldId);
    if (!Number.isFinite(fieldId)) return false;
    if (fieldId < 0) return true;
    const field = fields.find((f) => Number(f.id) === fieldId);
    if (!field) return false;
    if (!isPrintStorableField(field)) return false;
    return isPieceAgainFieldStored(field, storedFieldIds);
  });

export const resolvePrintQrModuleSize = (
  settings: { printQrModuleSize?: number } | null | undefined
): number => {
  const raw = Number(settings?.printQrModuleSize ?? 10);
  if (!Number.isFinite(raw)) return 10;
  return Math.min(16, Math.max(4, Math.round(raw)));
};

export const resolveMesaQrPrintSize = (
  settings: { mesaQrPrintSize?: number } | null | undefined
): number => {
  const raw = Number(settings?.mesaQrPrintSize ?? 120);
  if (!Number.isFinite(raw)) return 120;
  return Math.min(280, Math.max(80, Math.round(raw)));
};

/** Reaplica configuração atual de impressão ao payload (ex.: reimpressão). */
export const applyPrintSettingsToConteudo = (
  conteudo: Record<string, unknown>,
  formSettings: { printStoredFieldIds?: number[]; printQrModuleSize?: number } | null | undefined,
  fields: FormFieldLike[] = []
): Record<string, unknown> => {
  const printStoredFieldIds = resolvePrintStoredFieldIds(formSettings, fields);
  const printQrModuleSize = resolvePrintQrModuleSize(formSettings);
  const rawAnswers = Array.isArray(conteudo.answers)
    ? (conteudo.answers as PrintAnswer[])
    : [];
  return {
    ...conteudo,
    answers: filterAnswersForPrint(rawAnswers, fields, printStoredFieldIds),
    printQrModuleSize,
  };
};
