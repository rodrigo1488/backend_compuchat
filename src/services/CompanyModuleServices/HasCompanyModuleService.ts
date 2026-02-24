import CompanyModule from "../../models/CompanyModule";
import Module from "../../models/Module";

/** Slug do módulo de lanchonetes (mantido para compatibilidade) */
export const MODULE_LANCHONETES = "lanchonetes";

/**
 * Verifica se a empresa possui um módulo ativo.
 * @param companyId ID da empresa
 * @param moduleSlug Slug do módulo (ex: "lanchonetes") ou nome para fallback
 */
const HasCompanyModuleService = async (
  companyId: number,
  moduleSlug: string
): Promise<boolean> => {
  const module = await Module.findOne({
    where: { slug: moduleSlug, isActive: true },
  });
  if (!module) return false;

  const companyModule = await CompanyModule.findOne({
    where: { companyId, moduleId: module.id },
  });
  return !!companyModule;
};

export default HasCompanyModuleService;
