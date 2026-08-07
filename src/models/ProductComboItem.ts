import {
  Table,
  Column,
  CreatedAt,
  UpdatedAt,
  Model,
  DataType,
  PrimaryKey,
  AutoIncrement,
  ForeignKey,
  BelongsTo,
  Default,
} from "sequelize-typescript";
import Product from "./Product";

@Table
class ProductComboItem extends Model<ProductComboItem> {
  @PrimaryKey
  @AutoIncrement
  @Column
  id: number;

  @ForeignKey(() => Product)
  @Column
  comboProductId: number;

  @BelongsTo(() => Product, "comboProductId")
  comboProduct: Product;

  @ForeignKey(() => Product)
  @Column
  productId: number;

  @BelongsTo(() => Product, "productId")
  product: Product;

  @Column({
    type: DataType.DECIMAL(10, 2),
    allowNull: false,
  })
  value: number;

  @Default(1)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
  })
  quantity: number;

  @Default(0)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
  })
  order: number;

  @CreatedAt
  createdAt: Date;

  @UpdatedAt
  updatedAt: Date;
}

export default ProductComboItem;
