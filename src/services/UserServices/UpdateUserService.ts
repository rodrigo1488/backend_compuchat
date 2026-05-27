import * as Yup from "yup";

import AppError from "../../errors/AppError";
import ShowUserService from "./ShowUserService";
import Company from "../../models/Company";
import User from "../../models/User";
import { sanitizePageAccess } from "../../constants/pagePermissions";
import ListCompanyModulesService from "../CompanyModuleServices/ListCompanyModulesService";
import {
  filterPageAccessForModules,
  getModuleFlagsFromSlugs
} from "../../helpers/pagePermissionModules";

interface UserData {
  email?: string;
  password?: string;
  name?: string;
  profile?: string;
  companyId?: number;
  queueIds?: number[];
  whatsappId?: number;
  allTicket?: string;
  avatar?: string;
  defaultRoute?: string | null;
  pageAccess?: { granted?: string[]; denied?: string[] } | null;
}

interface Request {
  userData: UserData;
  userId: string | number;
  companyId: number;
  requestUserId: number;
}

interface Response {
  id: number;
  name: string;
  email: string;
  profile: string;
}

const UpdateUserService = async ({
  userData,
  userId,
  companyId,
  requestUserId
}: Request): Promise<Response | undefined> => {
  const user = await ShowUserService(userId);

  const requestUser = await User.findByPk(requestUserId);

  if (requestUser.super === false && userData.companyId !== companyId) {
    throw new AppError("O usuário não pertence à esta empresa");
  }

  const schema = Yup.object().shape({
    name: Yup.string().min(2),
    email: Yup.string().email(),
    profile: Yup.string(),
    password: Yup.string(),
    allTicket: Yup.string(),
    defaultRoute: Yup.string().nullable(),
  });

  const {
    email,
    password,
    profile,
    name,
    queueIds = [],
    whatsappId,
    allTicket,
    avatar,
    defaultRoute,
    pageAccess: pageAccessInput
  } = userData;

  try {
    await schema.validate({ email, password, profile, name, allTicket });
  } catch (err: any) {
    throw new AppError(err.message);
  }

  const nextProfile = profile !== undefined ? profile : user.profile;
  const companyModules = await ListCompanyModulesService(companyId);
  const moduleFlags = getModuleFlagsFromSlugs(companyModules);

  const sanitizePageAccessForCompany = (
    input: { granted?: string[]; denied?: string[] } | null | undefined
  ) => filterPageAccessForModules(sanitizePageAccess(input), moduleFlags);

  const updateData: Record<string, unknown> = {
    email,
    password,
    profile,
    name,
    whatsappId: whatsappId || null,
    allTicket,
    avatar: avatar !== undefined ? avatar : user.avatar,
    defaultRoute:
      defaultRoute !== undefined ? defaultRoute || null : user.defaultRoute
  };

  if (pageAccessInput !== undefined) {
    updateData.pageAccess =
      nextProfile === "admin" ? null : sanitizePageAccessForCompany(pageAccessInput);
  } else if (profile === "admin") {
    updateData.pageAccess = null;
  }

  await user.update(updateData);

  await user.$set("queues", queueIds);

  await user.reload();

  const company = await Company.findByPk(user.companyId);

  const serializedUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    profile: user.profile,
    companyId: user.companyId,
    company,
    queues: user.queues,
    avatar: user.avatar,
    defaultRoute: user.defaultRoute ?? null,
    pageAccess: user.pageAccess ?? null,
  };

  return serializedUser;
};

export default UpdateUserService;
