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
  HasMany,
} from "sequelize-typescript";
import Company from "./Company";
import AddOnSubgroup from "./AddOnSubgroup";
import AddOnItem from "./AddOnItem";

@Table
class AddOnGroup extends Model<AddOnGroup> {
  @PrimaryKey
  @AutoIncrement
  @Column
  id: number;

  @ForeignKey(() => Company)
  @Column
  companyId: number;

  @BelongsTo(() => Company)
  company: Company;

  @Column
  name: string;

  @HasMany(() => AddOnSubgroup)
  subgroups: AddOnSubgroup[];

  @HasMany(() => AddOnItem)
  items: AddOnItem[];

  @CreatedAt
  createdAt: Date;

  @UpdatedAt
  updatedAt: Date;
}

export default AddOnGroup;
