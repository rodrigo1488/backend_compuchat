import CompanyModule from "../../models/CompanyModule";
import Module from "../../models/Module";
import ListCompanyModulesService from "./ListCompanyModulesService";

/**
 * Remove um módulo da empresa pelo slug.
 */
const RemoveCompanyModuleService = async (
  companyId: number,
  moduleSlug: string
): Promise<string[]> => {
  const module = await Module.findOne({
    where: { slug: moduleSlug },
  });
  if (!module) return ListCompanyModulesService(companyId);

  await CompanyModule.destroy({
    where: { companyId, moduleId: module.id },
  });
  return ListCompanyModulesService(companyId);
};

export default RemoveCompanyModuleService;
