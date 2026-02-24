import Contact from "../../models/Contact";

interface Request {
  userId: number;
  companyId: number;
}

interface Response {
  contacts: Contact[];
  count: number;
}

const ListContactsByUserService = async ({
  userId,
  companyId
}: Request): Promise<Response> => {
  const { count, rows: contacts } = await Contact.findAndCountAll({
    where: {
      userId,
      companyId
    },
    attributes: ["id", "name", "number", "email", "profilePicUrl"],
    order: [["name", "ASC"]]
  });

  return {
    contacts,
    count
  };
};

export default ListContactsByUserService;
