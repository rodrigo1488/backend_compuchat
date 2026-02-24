import Product from "../../models/Product";
import AppError from "../../errors/AppError";

interface Request {
  productId: number;
  companyId: number;
}

const ShowProductService = async ({
  productId,
  companyId,
}: Request): Promise<Product> => {
  const product = await Product.findOne({
    where: { id: productId, companyId },
    include: [
      { association: "variations", include: [{ association: "options" }] },
    ],
  });

  if (!product) {
    throw new AppError("ERR_PRODUCT_NOT_FOUND", 404);
  }

  return product;
};

export default ShowProductService;
