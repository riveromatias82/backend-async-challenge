import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OrderDocument = HydratedDocument<Order>;

@Schema({ _id: false })
export class OrderItem {
  @Prop({ required: true })
  sku!: string;

  @Prop({ required: true })
  quantity!: number;
}

@Schema({ timestamps: true, collection: 'orders' })
export class Order {
  @Prop({ required: true })
  customerId!: string;

  @Prop({ required: true, enum: ['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED'] })
  status!: 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED';

  @Prop()
  rejectionReason?: string;

  @Prop({ type: [OrderItem], required: true })
  items!: OrderItem[];
}

export const OrderSchema = SchemaFactory.createForClass(Order);
