import Form from "../../models/Form";
import AppError from "../../errors/AppError";
import CreateFormService from "./CreateFormService";
import HasCompanyModuleService, { MODULE_LANCHONETES } from "../CompanyModuleServices/HasCompanyModuleService";

interface Request {
  companyId: number;
}

/**
 * Retorna o primeiro formulário de cardápio ativo da empresa.
 * Se não existir nenhum, cria um formulário "Cardápio" (desde que o módulo Lanchonetes esteja ativo).
 * Usado para mesas sem cardápio vinculado e para fallback no painel.
 */
const GetOrCreateDefaultCardapioFormService = async ({
  companyId,
}: Request): Promise<Form> => {
  const cardapioForms = await Form.findAll({
    where: { companyId, isActive: true },
    attributes: ["id", "slug", "companyId", "name", "settings"],
  });
  const firstCardapio = cardapioForms.find(
    (f) => (f.settings as any)?.formType === "cardapio"
  );
  if (firstCardapio) {
    return firstCardapio;
  }

  const hasModule = await HasCompanyModuleService(companyId, MODULE_LANCHONETES);
  if (!hasModule) {
    throw new AppError(
      "Configure o módulo Lanchonetes ou crie um formulário de cardápio na empresa.",
      404
    );
  }

  const form = await CreateFormService({
    name: "Cardápio",
    companyId,
    createdBy: 0,
    settings: { formType: "cardapio" },
  });

  return form;
};

export default GetOrCreateDefaultCardapioFormService;
