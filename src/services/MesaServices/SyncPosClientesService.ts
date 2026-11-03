import { Op, UniqueConstraintError } from "sequelize";
import { v4 as uuidv4 } from "uuid";
import Contact from "../../models/Contact";
import ContactCustomField from "../../models/ContactCustomField";
import CacheInvalidationService from "../CacheServices/CacheInvalidationService";

const EXTRA_KEYS = ["logradouro", "num_casa", "cpf", "obs"] as const;

export type PosClientePayload = {
  id?: number | null;
  cloudContactId?: number | null;
  nome?: string | null;
  tel?: string | null;
  logradouro?: string | null;
  numCasa?: string | null;
  num_casa?: string | null;
  cpf?: string | null;
  obs?: string | null;
};

export type PosClienteDto = {
  id: number;
  nome: string;
  tel: string;
  logradouro: string;
  numCasa: string;
  cpf: string;
  obs: string;
};

const digitsOnly = (raw: unknown): string =>
  String(raw || "").replace(/\D/g, "");

const normalizePhone = (raw: unknown): string => {
  let digits = digitsOnly(raw);
  if (!digits) return "";
  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }
  return digits;
};

const isPlaceholderPhone = (number: string): boolean =>
  !number || number.startsWith("SEMTELEFONE-");

const extraMap = (
  fields: ContactCustomField[] | undefined
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const field of fields || []) {
    const key = String(field.name || "").trim().toLowerCase();
    if (!key) continue;
    out[key] = String(field.value || "").trim();
  }
  return out;
};

const toDto = (contact: Contact): PosClienteDto => {
  const extras = extraMap(contact.extraInfo);
  const number = String(contact.number || "");
  return {
    id: contact.id,
    nome: String(contact.name || "").trim(),
    tel: isPlaceholderPhone(number) ? "" : number,
    logradouro: extras.logradouro || extras.rua || extras.address || "",
    numCasa: extras.num_casa || extras.numcasa || extras.numero || "",
    cpf: digitsOnly(extras.cpf),
    obs: extras.obs || extras.observacao || extras.observation || "",
  };
};

const desiredExtras = (cliente: PosClientePayload): { name: string; value: string }[] => {
  const pairs: { name: string; value: string }[] = [
    { name: "logradouro", value: String(cliente.logradouro || "").trim() },
    {
      name: "num_casa",
      value: String(cliente.numCasa || cliente.num_casa || "").trim(),
    },
    { name: "cpf", value: digitsOnly(cliente.cpf) },
    { name: "obs", value: String(cliente.obs || "").trim() },
  ];
  return pairs.filter(item => item.value);
};

const upsertExtras = async (
  contactId: number,
  cliente: PosClientePayload
): Promise<void> => {
  const desired = desiredExtras(cliente);
  const existing = await ContactCustomField.findAll({ where: { contactId } });
  const byName = new Map(
    existing.map(row => [String(row.name || "").toLowerCase(), row])
  );

  for (const key of EXTRA_KEYS) {
    const want = desired.find(item => item.name === key);
    const row = byName.get(key);
    if (!want) {
      if (row) await row.destroy();
      continue;
    }
    if (row) {
      if (row.value !== want.value) {
        await row.update({ value: want.value });
      }
    } else {
      await ContactCustomField.create({
        contactId,
        name: want.name,
        value: want.value,
      });
    }
  }
};

const findByPhone = async (
  companyId: number,
  phone: string
): Promise<Contact | null> => {
  if (!phone) return null;
  const candidates = new Set<string>([phone]);
  if (phone.startsWith("55") && phone.length >= 12) {
    candidates.add(phone.slice(2));
  } else if (phone.length === 10 || phone.length === 11) {
    candidates.add(`55${phone}`);
  }
  return Contact.findOne({
    where: {
      companyId,
      isGroup: false,
      number: { [Op.in]: [...candidates] },
    },
    include: ["extraInfo"],
  });
};

const upsertOne = async (
  companyId: number,
  cliente: PosClientePayload
): Promise<Contact> => {
  const nome = String(cliente.nome || "").trim() || "Cliente";
  const phone = normalizePhone(cliente.tel);
  const cloudId = Number(cliente.cloudContactId || cliente.id || 0);

  let contact: Contact | null = null;
  if (cloudId > 0) {
    contact = await Contact.findOne({
      where: { id: cloudId, companyId, isGroup: false },
      include: ["extraInfo"],
    });
  }
  if (!contact && phone) {
    contact = await findByPhone(companyId, phone);
  }

  if (contact) {
    const patch: Record<string, unknown> = {};
    if (nome && contact.name !== nome) patch.name = nome;
    if (phone && !isPlaceholderPhone(contact.number) && contact.number !== phone) {
      // Mantém telefone real existente; só preenche se era placeholder.
    } else if (phone && isPlaceholderPhone(contact.number)) {
      patch.number = phone;
    }
    if (Object.keys(patch).length) {
      await contact.update(patch);
    }
    await upsertExtras(contact.id, cliente);
    void CacheInvalidationService.onContactChanged(companyId, contact.id);
    await contact.reload({ include: ["extraInfo"] });
    return contact;
  }

  const number = phone || `SEMTELEFONE-${companyId}-${uuidv4()}`;
  try {
    contact = await Contact.create({
      name: nome,
      number,
      email: "",
      companyId,
      userId: null,
      profilePicUrl: "",
      isGroup: false,
      disableBot: true,
    } as any);
  } catch (err) {
    if (err instanceof UniqueConstraintError && phone) {
      const again = await findByPhone(companyId, phone);
      if (again) {
        await upsertExtras(again.id, cliente);
        await again.reload({ include: ["extraInfo"] });
        return again;
      }
    }
    throw err;
  }
  await upsertExtras(contact.id, cliente);
  void CacheInvalidationService.onContactChanged(companyId, contact.id);
  await contact.reload({ include: ["extraInfo"] });
  return contact;
};

export const syncPosClientes = async ({
  companyId,
  clientes = [],
}: {
  companyId: number;
  clientes?: PosClientePayload[];
}): Promise<{ clientes: PosClienteDto[]; pushed: number; pulled: number }> => {
  let pushed = 0;
  for (const cliente of clientes) {
    const nome = String(cliente?.nome || "").trim();
    if (!nome) continue;
    await upsertOne(companyId, cliente);
    pushed += 1;
  }

  const contacts = await Contact.findAll({
    where: { companyId, isGroup: false },
    include: ["extraInfo"],
    order: [
      ["updatedAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: 5000,
  });

  const dtos = contacts.map(toDto).filter(item => item.nome);
  return { clientes: dtos, pushed, pulled: dtos.length };
};

export default syncPosClientes;
