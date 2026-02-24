import CompanyModule from "../../models/CompanyModule";
import Module from "../../models/Module";

/**
 * Lista os slugs dos módulos ativos da empresa.
 */
const ListCompanyModulesService = async (
  companyId: number
): Promise<string[]> => {
  const companyModules = await CompanyModule.findAll({
    where: { companyId },
    include: [{ model: Module, as: "module", where: { isActive: true }, required: true }],
  });

  return companyModules
    .map((cm) => (cm.module as Module)?.slug)
    .filter(Boolean);
};

export default ListCompanyModulesService;
