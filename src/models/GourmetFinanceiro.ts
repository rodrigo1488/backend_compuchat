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
} from "sequelize-typescript";
import Company from "./Company";

@Table({ tableName: "GourmetFinanceiro" })
class GourmetFinanceiro extends Model<GourmetFinanceiro> {
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
  tipo: string;

  @Column({
    type: DataType.DECIMAL(10, 2),
    allowNull: false,
  })
  valor: number;

  @Column
  dataVenda: string;

  @Column
  mesaId: number;

  @Column
  mesaNumero: string;

  @Column
  formResponseId: number;

  @Column
  protocol: string;

  @Column
  entregadorUserId: number;

  @Column
  entregadorNome: string;

  @CreatedAt
  createdAt: Date;

  @UpdatedAt
  updatedAt: Date;
}

export default GourmetFinanceiro;
