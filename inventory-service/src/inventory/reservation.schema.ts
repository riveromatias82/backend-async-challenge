import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ReservationDocument = HydratedDocument<Reservation>;

@Schema({ _id: false })
export class ReservationItem {
  @Prop({ required: true })
  sku!: string;

  @Prop({ required: true })
  quantity!: number;
}

@Schema({ timestamps: true, collection: 'reservations' })
export class Reservation {
  @Prop({ required: true, unique: true })
  orderId!: string;

  @Prop({ required: true, enum: ['RESERVED', 'RELEASED', 'FAILED'] })
  status!: 'RESERVED' | 'RELEASED' | 'FAILED';

  @Prop()
  failureReason?: string;

  @Prop({ type: [ReservationItem], required: true })
  items!: ReservationItem[];
}

export const ReservationSchema = SchemaFactory.createForClass(Reservation);
