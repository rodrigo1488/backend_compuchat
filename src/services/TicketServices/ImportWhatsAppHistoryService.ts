import path from "path";
import fs from "fs";
import { promisify } from "util";
import extract from "extract-zip";
import { v4 as uuidv4 } from "uuid";
import sequelize from "../../database";
import AppError from "../../errors/AppError";
import { getIO } from "../../libs/socket";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";
import ShowContactService from "../ContactServices/ShowContactService";
import CreateTicketService from "./CreateTicketService";
import {
  parseWhatsAppExport,
  isMediaFileName,
  inferMediaTypeFromFilename,
  ParticipantSide
} from "../../utils/whatsappExportParser";

const MAX_MESSAGES = 10000;
const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);
const rmdir = promisify(fs.rm);

const publicFolder = path.resolve(__dirname, "..", "..", "..", "public");

export type ParticipantMapping = Record<string, ParticipantSide>;

interface Request {
  companyId: number;
  userId: number;
  contactId: number;
  whatsappId?: number;
  queueId?: number;
  ticketStatus: "open" | "pending" | "closed";
  participantMapping: ParticipantMapping;
  filePath: string;
  originalName: string;
  appendToExisting?: boolean;
}

interface Response {
  ticketId: number;
  uuid: string;
  importedCount: number;
  mediaAttachedCount: number;
  skippedSystemLines: number;
}

const walkDir = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDir(full)));
    } else {
      files.push(full);
    }
  }
  return files;
};

const findTxtInDir = async (dir: string): Promise<{ path: string; name: string }> => {
  const all = await walkDir(dir);
  const txts = all.filter(f => /\.txt$/i.test(f));
  if (!txts.length) {
    throw new AppError("ERR_WHATSAPP_IMPORT_NO_TXT", 400);
  }
  const sorted = txts.sort((a, b) => {
    const sa = fs.statSync(a).size;
    const sb = fs.statSync(b).size;
    return sb - sa;
  });
  return { path: sorted[0], name: path.basename(sorted[0]) };
};

const loadExportFromFile = async (
  filePath: string,
  originalName: string
): Promise<{ rawText: string; txtFileName: string; mediaFiles: string[]; tempDir: string | null }> => {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === ".txt") {
    const rawText = await readFile(filePath, "utf8");
    return { rawText, txtFileName: originalName, mediaFiles: [], tempDir: null };
  }

  if (ext !== ".zip") {
    throw new AppError("ERR_WHATSAPP_IMPORT_INVALID_FILE", 400);
  }

  const tempDir = path.join(publicFolder, "import-temp", uuidv4());
  fs.mkdirSync(tempDir, { recursive: true });
  await extract(filePath, { dir: tempDir });

  const { path: txtPath, name: txtFileName } = await findTxtInDir(tempDir);
  const rawText = await readFile(txtPath, "utf8");
  const allFiles = await walkDir(tempDir);
  const mediaFiles = allFiles
    .filter(f => isMediaFileName(f))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  return { rawText, txtFileName, mediaFiles, tempDir };
};

const cleanupTemp = async (tempDir: string | null) => {
  if (!tempDir || !fs.existsSync(tempDir)) return;
  try {
    await rmdir(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
};

const ImportWhatsAppHistoryService = async ({
  companyId,
  userId,
  contactId,
  whatsappId,
  queueId,
  ticketStatus,
  participantMapping,
  filePath,
  originalName,
  appendToExisting = true
}: Request): Promise<Response> => {
  const contact = await ShowContactService(contactId, companyId);
  if (!contact?.number) {
    throw new AppError("ERR_CONTACT_NO_NUMBER", 400);
  }

  let tempDir: string | null = null;
  let mediaFiles: string[] = [];

  try {
    const loaded = await loadExportFromFile(filePath, originalName);
    tempDir = loaded.tempDir;
    mediaFiles = loaded.mediaFiles;

    const parsed = parseWhatsAppExport(loaded.rawText, {
      fileName: originalName,
      txtFileName: loaded.txtFileName
    });

    if (!parsed.messages.length) {
      throw new AppError("ERR_WHATSAPP_IMPORT_EMPTY", 400);
    }
    if (parsed.messages.length > MAX_MESSAGES) {
      throw new AppError("ERR_WHATSAPP_IMPORT_TOO_MANY", 400);
    }

    const ticket = await CreateTicketService({
      contactId,
      status: ticketStatus,
      userId,
      companyId,
      queueId,
      whatsappId: whatsappId !== undefined ? String(whatsappId) : undefined,
      reuseOpenTicket: appendToExisting
    });

    await ticket.update({
      status: ticketStatus,
      queueId: queueId ?? ticket.queueId,
      userId: userId ?? ticket.userId
    });

    if (!appendToExisting) {
      const existingCount = await Message.count({
        where: { ticketId: ticket.id, companyId }
      });
      if (existingCount > 0) {
        throw new AppError("ERR_WHATSAPP_IMPORT_TICKET_HAS_MESSAGES", 409);
      }
    }

    let mediaIndex = 0;
    let mediaAttachedCount = 0;
    const importBatch = uuidv4().slice(0, 8);

    const rows = parsed.messages.map((msg, index) => {
      const author = msg.author || "";
      const side: ParticipantSide =
        participantMapping[author] ||
        (Object.values(participantMapping)[0] as ParticipantSide) ||
        "contact";
      const fromMe = side === "me";

      let body = msg.body;
      let mediaUrl: string | null = null;
      let mediaType = "conversation";

      if (msg.isMedia) {
        mediaType = "document";
        if (mediaIndex < mediaFiles.length) {
          const src = mediaFiles[mediaIndex];
          mediaIndex += 1;
          const baseName = path.basename(src);
          const destName = `import-${importBatch}-${index}-${baseName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          const destPath = path.join(publicFolder, destName);
          fs.copyFileSync(src, destPath);
          mediaUrl = destName;
          mediaType = inferMediaTypeFromFilename(baseName);
          mediaAttachedCount += 1;
          if (!body || body.toLowerCase().includes("mídia") || body.toLowerCase().includes("media omitted")) {
            body = baseName;
          }
        } else {
          body = body || "[Mídia]";
          mediaType = "document";
        }
      }

      if (!body?.trim()) {
        body = "[Mensagem vazia]";
      }

      return {
        id: `IMPORT:${companyId}:${ticket.id}:${importBatch}:${index}`,
        body,
        fromMe,
        read: true,
        ack: fromMe ? 2 : 0,
        mediaType,
        mediaUrl,
        ticketId: ticket.id,
        contactId: fromMe ? null : contact.id,
        companyId,
        queueId: queueId ?? ticket.queueId ?? null,
        createdAt: msg.datetime,
        updatedAt: msg.datetime
      };
    });

    const lastRow = rows[rows.length - 1];

    await sequelize.transaction(async t => {
      await Message.bulkCreate(rows, { transaction: t });
      await ticket.update(
        {
          lastMessage: lastRow.body,
          fromMe: lastRow.fromMe,
          status: ticketStatus
        },
        { transaction: t }
      );
    });

    const fullTicket = await Ticket.findByPk(ticket.id, {
      include: ["contact", "queue", "whatsapp"]
    });

    const io = getIO();
    io.to(`company-${companyId}-mainchannel`)
      .to(ticket.id.toString())
      .emit(`company-${companyId}-ticket`, {
        action: "update",
        ticket: fullTicket
      });

    io.to(`company-${companyId}-mainchannel`)
      .to(ticket.id.toString())
      .emit(`company-${companyId}-appMessage`, {
        action: "import",
        ticketId: ticket.id,
        count: rows.length
      });

    return {
      ticketId: ticket.id,
      uuid: ticket.uuid,
      importedCount: rows.length,
      mediaAttachedCount,
      skippedSystemLines: parsed.systemLinesSkipped
    };
  } finally {
    await cleanupTemp(tempDir);
    if (filePath) {
      try {
        if (fs.existsSync(filePath)) {
          await unlink(filePath);
        }
      } catch {
        // ignore
      }
    }
  }
};

export default ImportWhatsAppHistoryService;
