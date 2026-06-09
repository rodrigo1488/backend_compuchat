import { FindOptions } from "sequelize";
import Form from "../../models/Form";
import AppError from "../../errors/AppError";
import { assertCompanyPublicAccess } from "../../helpers/companyPublicAccess";

type PublicFormFindOptions = Omit<FindOptions, "where">;

export const findPublicFormBySlug = async (
  publicId: string,
  options: PublicFormFindOptions = {}
): Promise<Form> => {
  const form = await Form.findOne({
    where: { publicId, isActive: true },
    ...options,
  });

  if (!form) {
    throw new AppError("ERR_FORM_NOT_FOUND", 404);
  }

  await assertCompanyPublicAccess(form.companyId);
  return form;
};

export const findPublicFormById = async (
  id: number,
  options: PublicFormFindOptions = {}
): Promise<Form> => {
  const form = await Form.findOne({
    where: { id, isActive: true },
    ...options,
  });

  if (!form) {
    throw new AppError("ERR_FORM_NOT_FOUND", 404);
  }

  await assertCompanyPublicAccess(form.companyId);
  return form;
};
