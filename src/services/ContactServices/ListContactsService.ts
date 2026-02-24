import { Sequelize, Op } from "sequelize";
import Contact from "../../models/Contact";
import User from "../../models/User";

interface Request {
  searchParam?: string;
  pageNumber?: string;
  companyId: number;
}

interface Response {
  contacts: Contact[];
  count: number;
  hasMore: boolean;
}

const ListContactsService = async ({
  searchParam = "",
  pageNumber = "1",
  companyId
}: Request): Promise<Response> => {
  const whereCondition: any = {
    companyId: {
      [Op.eq]: companyId
    }
  };

  // Adicionar busca apenas se searchParam não estiver vazio
  if (searchParam && searchParam.trim()) {
    whereCondition[Op.or] = [
      {
        name: Sequelize.where(
          Sequelize.fn("LOWER", Sequelize.col("Contact.name")),
          "LIKE",
          `%${searchParam.toLowerCase().trim()}%`
        )
      },
      { number: { [Op.like]: `%${searchParam.toLowerCase().trim()}%` } }
    ];
  }
  const limit = 30;
  const offset = limit * (+pageNumber - 1);

  try {
    const { count, rows: contacts } = await Contact.findAndCountAll({
      where: whereCondition,
      limit,
      offset,
      order: [[Sequelize.col("Contact.name"), "ASC"]],
      include: [
        {
          model: User,
          as: "user",
          required: false, // LEFT JOIN para incluir contatos sem usuário vinculado
          attributes: ["id", "name", "email"]
        }
      ]
    });

    const hasMore = count > offset + contacts.length;

    return {
      contacts,
      count,
      hasMore
    };
  } catch (error: any) {
    // Se houver erro com o include (coluna userId pode não existir ainda), tentar sem o include
    console.error("Erro ao listar contatos com include de user:", error.message);
    const { count, rows: contacts } = await Contact.findAndCountAll({
      where: whereCondition,
      limit,
      offset,
      order: [[Sequelize.col("Contact.name"), "ASC"]]
    });

    const hasMore = count > offset + contacts.length;

    return {
      contacts,
      count,
      hasMore
    };
  }

};

export default ListContactsService;
