import { Op } from "sequelize";

import User from "../../models/User";
import AppError from "../../errors/AppError";

interface Request {
  userId: string | number;
  companyId: number;
  requestUserId: number;
  active: boolean;
}

const SetUserActiveService = async ({
  userId,
  companyId,
  requestUserId,
  active,
}: Request): Promise<User> => {
  const user = await User.findOne({
    where: { id: userId, companyId },
  });

  if (!user) {
    throw new AppError("ERR_NO_USER_FOUND", 404);
  }

  if (active === false) {
    if (Number(user.id) === Number(requestUserId)) {
      throw new AppError("ERR_CANNOT_DEACTIVATE_SELF", 400);
    }

    if (user.profile === "admin") {
      const otherActiveAdmins = await User.count({
        where: {
          companyId,
          profile: "admin",
          active: true,
          id: { [Op.ne]: user.id },
        },
      });
      if (otherActiveAdmins === 0) {
        throw new AppError("ERR_LAST_ACTIVE_ADMIN", 400);
      }
    }

    await user.update({
      active: false,
      tokenVersion: user.tokenVersion + 1,
      online: false,
    });
  } else {
    await user.update({ active: true });
  }

  await user.reload();
  return user;
};

export default SetUserActiveService;
