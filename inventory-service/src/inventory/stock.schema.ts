import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StockItemDocument = HydratedDocument<StockItem>;

@Schema({ timestamps: true, collection: 'stockItems' })
export class StockItem {
  @Prop({ required: true, unique: true })
  sku!: string;

  @Prop({ required: true, default: 0 })
  availableQuantity!: number;

  @Prop({ required: true, default: 0 })
  reservedQuantity!: number;
}

export const StockItemSchema = SchemaFactory.createForClass(StockItem);
