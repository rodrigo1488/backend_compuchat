import AddOnItem from "../../models/AddOnItem";
import AddOnGroup from "../../models/AddOnGroup";
import AppError from "../../errors/AppError";
import { releaseUniplusCodigo } from "./ReleaseUniplusCodigoService";

export interface LinkUniplusAddOnRequest {
  companyId: number;
  codigo: string;
  addOnItemId: number;
}

export interface LinkUniplusAddOnResult {
  addOnItemId: number;
  label: string;
  removedProductId?: number;
  clearedOptionIds: number[];
}

/**
 * Vincula um codigo UniPlus a um adicional (AddOnItem) existente, pra que o
 * pedido emita uma linha própria de CONTAMESAITEM pra ele (e o UniPlus
 * movimente o estoque do adicional). Libera o codigo de qualquer vínculo
 * anterior (produto avulso, opção de variação ou outro adicional) primeiro.
 */
const LinkUniplusAddOnService = async ({
  companyId,
  codigo: rawCodigo,
  addOnItemId,
}: LinkUniplusAddOnRequest): Promise<LinkUniplusAddOnResult> => {
  const codigo = String(rawCodigo || "").trim().slice(0, 20);
  if (!codigo) {
    throw new AppError("ERR_UNIPLUS_ATTACH_CODIGO_REQUIRED", 400);
  }
  if (!Number.isFinite(Number(addOnItemId)) || Number(addOnItemId) <= 0) {
    throw new AppError("ERR_UNIPLUS_ADDON_ID_REQUIRED", 400);
  }

  const addOnItem = await AddOnItem.findOne({
    where: { id: Number(addOnItemId) },
    include: [
      {
        model: AddOnGroup,
        required: true,
        where: { companyId },
        attributes: ["id", "companyId"],
      },
    ],
  });
  if (!addOnItem) {
    throw new AppError("ERR_UNIPLUS_ADDON_NOT_FOUND", 404);
  }

  const released = await releaseUniplusCodigo(companyId, codigo, {
    exceptAddOnItemId: addOnItem.id,
  });

  addOnItem.idUniplus = codigo;
  await addOnItem.save();

  return {
    addOnItemId: addOnItem.id,
    label: addOnItem.label,
    removedProductId: released.removedProductId,
    clearedOptionIds: released.clearedOptionIds,
  };
};

export default LinkUniplusAddOnService;
